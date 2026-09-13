import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  ActionRequest,
  ActionResponse,
  Capture,
  CaptureResponse,
  CaptureSource,
  CortexStatus,
  DecayConfig,
  DemoResetResponse,
  HealthResponse,
  HistoryAction,
  HistoryResponse,
  JsonValue,
  PipelineStage,
  PivotLogCreateRequest,
  PivotLogCreateResponse,
  PivotLogEntry,
  PivotLogResponse,
  Plan,
  PlanContext,
  PlanTrigger,
  Profile,
  ProfileResponse,
  PutProfileRequest,
  PutTimetableRequest,
  RerankRequest,
  RerankResponse,
  Source,
  Task,
  TimetableResponse,
  TodayTimetableResponse,
} from '../types';
import type { AppConfig } from '../config';
import { createClock, dateOnly, isoDow, toIsoLocal, toNtzLocal, type Clock } from '../clock';
import { errorMessage, log } from '../log';
import { buildPlan, expiredTaskIds, hydratePlan, RANKER_MODEL, readCashValue } from '../ranker/plan';
import { DEFAULT_DECAY_CONFIG } from '../ranker/decay';
import { heuristicExtract, type ConstraintDraft } from '../ranker/extract';
import { diffPlans } from '../ranker/diff';
import { mergeRerankContext } from '../ranker/questions';
import { isExpired, isOpenStatus } from '../ranker/rules';
import { computeFreeWindows } from '../ranker/windows';
import { applyDemoCopy, applyDemoDiffCopy } from '../demo/fixtures';
import { createTranscriptExtractor, type TranscriptExtractor } from '../llm/extractor';
import {
  cortexEngine,
  elapsed,
  ENGINE,
  extractStage,
  now as perfNow,
  rankStage,
  rerankExtractStage,
  skippedStage,
  snowflakeWordingEngine,
  SQL_PRERANK_MODEL,
  stage,
  transcribeStage,
  wordingStage,
  type ChipTask,
} from '../pipeline';
import { isConnectionError, putFile, SnowflakeClient, withSqlLogging, withTimeout, type SqlExecutor } from '../snowflake/client';
import { describeCortex, emptyCortexStatus, readCortexConfig, verifyCortex } from '../snowflake/cortex';
import { PipRepo, readExtractResult, type ExtractSummary } from '../snowflake/repo';
import { asRecord, normalizePlanFromSnowflake, parseAction, procedureError } from '../snowflake/rows';
import type { Backend, CaptureTextInput, CaptureVoiceInput, WarmPingResponse } from './backend';

export interface LiveTimeouts {
  /** captureText / captureVoice / rerank (below the iOS 60 s timeout, so PipService can still fall back) */
  captureMs: number;
  /** every other Snowflake-touching method */
  defaultMs: number;
  /** SELECT 1 (+ CORTEX_CONFIG read) inside /health; the iOS launch check gives up after 4 s */
  healthMs: number;
  /** how long /health?refresh=1 waits for Cortex re-verification before answering with the last known status */
  refreshWaitMs: number;
}

export const DEFAULT_LIVE_TIMEOUTS: LiveTimeouts = { captureMs: 45_000, defaultMs: 12_000, healthMs: 3_000, refreshWaitMs: 6_000 };

export interface LiveBackendOptions {
  timeouts?: Partial<LiveTimeouts>;
  /** runs when EXTRACT_FROM_TRANSCRIPT errors or finds no tasks (Claude first when configured); default: heuristic parser only */
  extractor?: TranscriptExtractor;
}

interface PlanRequest {
  studentId: string;
  captureId: string | null;
  trigger: PlanTrigger;
  /** context for the TypeScript fallback (BUILD_PLAN derives its own from `extra`) */
  context: PlanContext;
  /** EXTRA_CONTEXT keys besides now_local and trigger */
  extra: { [key: string]: JsonValue };
  previous: Plan | null;
}

interface PlanOutcome {
  plan: Plan;
  source: Source;
  /** open, non-expired tasks */
  tasks: Task[];
  /** rank + wording pipeline stages */
  stages: PipelineStage[];
}

interface Transcription {
  transcript: string | null;
  stagePath: string;
}

function openOnly(tasks: readonly Task[], now: Date): Task[] {
  return tasks.filter((t) => isOpenStatus(t) && !isExpired(t, now));
}

function decayOrDefault(decay: DecayConfig[]): readonly DecayConfig[] {
  return decay.length > 0 ? decay : DEFAULT_DECAY_CONFIG;
}

function safeSegment(value: string): string {
  const s = value.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
  return s === '' ? 'student' : s;
}

function defaultProfile(studentId: string, updatedAt: string): Profile {
  return {
    student_id: studentId,
    chronotype: 'neutral',
    cooks_own_meals: true,
    cash_available: 0,
    budget_until: null,
    procrastinates_on: null,
    updated_at: updatedAt,
  };
}

/** BUILD_PLAN walked the Cortex chain and every attempt failed (it still returned a SQL pre-rank plan). */
function hadCortexErrors(raw: unknown): boolean {
  const errors = asRecord(raw)?.cortex_errors;
  return Array.isArray(errors) && errors.length > 0;
}

/**
 * Snowflake-backed implementation. Plans come from CALL BUILD_PLAN (source 'snowflake'); when BUILD_PLAN fails or returns
 * an invalid plan, the TypeScript ranker runs over Snowflake-loaded data and the plan is stored in PLANS (source 'fallback').
 * Anything that cannot reach Snowflake throws (or times out), and PipService answers from the in-memory backend instead.
 */
export class LiveBackend implements Backend {
  readonly config: AppConfig;
  readonly clock: Clock;
  private readonly db: SqlExecutor;
  private readonly repo: PipRepo;
  private readonly client: SnowflakeClient | null;
  private readonly timeouts: LiveTimeouts;
  private readonly extractor: TranscriptExtractor;
  private lastWarmPingAt: string | null = null;
  /** verified by this process */
  private cortex: CortexStatus | null = null;
  /** read from CORTEX_CONFIG while nothing has been verified yet */
  private storedCortex: CortexStatus | null = null;
  private lastCortexErrors: string[] = [];
  private cortexRun: Promise<CortexStatus> | null = null;

  constructor(config: AppConfig, clock?: Clock, executor?: SqlExecutor, options: LiveBackendOptions = {}) {
    this.config = config;
    this.clock = clock ?? createClock({ demoNow: config.demoNow, mode: config.mode });
    this.timeouts = { ...DEFAULT_LIVE_TIMEOUTS, ...options.timeouts };
    this.extractor = options.extractor ?? createTranscriptExtractor(null);
    if (executor) {
      this.client = null;
      this.db = withSqlLogging(executor);
    } else {
      this.client = new SnowflakeClient({ settings: config.snowflake, timezone: config.timezone });
      this.db = this.client;
    }
    this.repo = new PipRepo(this.db);
  }

  async close(): Promise<void> {
    if (this.client) await this.client.close();
  }

  private guard<T>(op: string, ms: number, fn: () => Promise<T>): Promise<T> {
    return withTimeout(fn(), ms, `snowflake ${op}`);
  }

  private realIso(): string {
    return toIsoLocal(this.clock.realNow());
  }

  // -------------------------------------------------------------------------
  // Cortex / health
  // -------------------------------------------------------------------------

  /** Runs verifyCortex once at a time; the result is cached (only when Snowflake was reachable). Never rejects. */
  verifyCortexInBackground(force = false): Promise<CortexStatus> {
    if (this.cortexRun) return this.cortexRun;
    if (this.cortex && !force) return Promise.resolve(this.cortex);
    const run = verifyCortex(this.db, { now: () => this.clock.realNow() }).then((status) => {
      if (status.verified_at !== null) {
        this.cortex = status;
        this.lastCortexErrors = [];
        log.info(`Cortex verified: ${describeCortex(status)}`);
        if (status.errors.length > 0) log.warn(`Cortex verification errors: ${status.errors.join(' | ')}`);
      } else {
        this.lastCortexErrors = status.errors;
        log.warn(`Cortex verification could not run: ${status.errors.join(' | ')}`);
      }
      return status;
    });
    const tracked = run.finally(() => {
      this.cortexRun = null;
    });
    this.cortexRun = tracked;
    return tracked;
  }

  async health(refresh: boolean): Promise<HealthResponse> {
    const started = Date.now();
    let connected = false;
    let error: string | null = null;
    try {
      await withTimeout(this.repo.ping(), this.timeouts.healthMs, 'snowflake health check');
      connected = true;
    } catch (err) {
      error = errorMessage(err);
      log.warn(`health: Snowflake not reachable: ${error}`);
    }

    if (connected) {
      if (refresh || (this.cortex === null && this.cortexRun === null)) {
        const run = this.verifyCortexInBackground(refresh);
        if (refresh) {
          try {
            await withTimeout(run, this.timeouts.refreshWaitMs, 'cortex verification');
          } catch {
            log.info('Cortex verification is still running; /health answers with the last known status');
          }
        }
      }
      if (this.cortex === null) {
        const left = Math.max(250, this.timeouts.healthMs - (Date.now() - started));
        try {
          this.storedCortex = (await withTimeout(readCortexConfig(this.db), left, 'CORTEX_CONFIG read')) ?? this.storedCortex;
        } catch (err) {
          log.debug(`health: CORTEX_CONFIG read failed: ${errorMessage(err)}`);
        }
      }
    }

    const fallbackErrors = connected
      ? this.lastCortexErrors.length > 0
        ? [...this.lastCortexErrors]
        : ['Cortex not verified yet (GET /health?refresh=1 runs the check)']
      : [error ?? 'not connected'];
    const cortex = this.cortex ?? this.storedCortex ?? emptyCortexStatus(fallbackErrors);
    return {
      source: connected ? 'snowflake' : 'fallback',
      ok: true,
      mode: 'live',
      now: toIsoLocal(this.clock.now()),
      snowflake: {
        configured: this.config.snowflakeConfigured,
        connected,
        error,
        last_warm_ping_at: this.lastWarmPingAt,
      },
      cortex: { ...cortex, errors: [...cortex.errors] },
      claude: { ...this.extractor.claude },
    };
  }

  // -------------------------------------------------------------------------
  // Planning
  // -------------------------------------------------------------------------

  /** CALL BUILD_PLAN -> normalize -> hydrate; on failure the TypeScript ranker over Snowflake data, stored in PLANS. */
  private async planWithFallback(req: PlanRequest): Promise<PlanOutcome> {
    const now = this.clock.now();
    const nowNtz = toNtzLocal(now);
    let plan: Plan | null = null;
    let cortexFailed = false;
    const callStarted = perfNow();
    try {
      const raw = await this.repo.callBuildPlan(req.studentId, req.captureId, { now_local: nowNtz, trigger: req.trigger, ...req.extra });
      const procError = procedureError(raw);
      if (procError !== null) throw new Error(`BUILD_PLAN returned error: ${procError}`);
      cortexFailed = hadCortexErrors(raw);
      plan = normalizePlanFromSnowflake(raw);
    } catch (err) {
      if (isConnectionError(err)) throw err;
      log.warn(`BUILD_PLAN failed, building the plan with the TypeScript ranker: ${errorMessage(err)}`);
    }
    const callMs = elapsed(callStarted);

    if (plan) {
      const [tasks, decay] = await Promise.all([this.repo.openTasks(req.studentId), this.repo.decay()]);
      const hydrated = hydratePlan(plan, tasks, decayOrDefault(decay), now);
      // a Cortex model wrote the wording even if earlier models in the chain failed; sql-prerank after errors is a step down
      const wordingFellBack = cortexFailed && hydrated.model === SQL_PRERANK_MODEL;
      return {
        plan: hydrated,
        source: 'snowflake',
        tasks: openOnly(tasks, now),
        stages: [
          rankStage(ENGINE.sqlPreRank, 'ok', callMs, hydrated),
          // BUILD_PLAN ranks and words in one call, so its time is on the rank stage
          wordingStage(snowflakeWordingEngine(hydrated.model), wordingFellBack ? 'fallback' : 'ok', null, hydrated, wordingFellBack ? 'Cortex failed' : 'In BUILD_PLAN'),
        ],
      };
    }

    const [tasks, timetable, profile, constraints, decay] = await Promise.all([
      this.repo.openTasks(req.studentId),
      this.repo.timetable(req.studentId),
      this.repo.profile(req.studentId),
      req.captureId ? this.repo.constraints(req.captureId) : Promise.resolve([]),
      this.repo.decay(),
    ]);
    const created = this.clock.realNow();
    const rankStarted = perfNow();
    const raw = buildPlan({
      plan_id: randomUUID(),
      student_id: req.studentId,
      capture_id: req.captureId,
      created_at: toIsoLocal(created),
      now,
      tasks,
      timetable,
      profile: profile ?? defaultProfile(req.studentId, toIsoLocal(created)),
      constraints,
      context: req.context,
      trigger: req.trigger,
      previous_plan: req.previous,
      decay: decayOrDefault(decay),
      model: RANKER_MODEL,
    });
    const rankMs = elapsed(rankStarted);
    const wordingStarted = perfNow();
    const fallbackPlan = applyDemoCopy(raw, tasks, { pinned: this.clock.pinned, now });
    const wordingMs = elapsed(wordingStarted);
    if (expiredTaskIds(tasks, now).length > 0) await this.repo.expireTasks(req.studentId, nowNtz);
    await this.repo.insertPlan(fallbackPlan);
    return {
      plan: fallbackPlan,
      source: 'fallback',
      tasks: openOnly(tasks, now),
      stages: [
        rankStage(ENGINE.tsRanker, 'fallback', rankMs, fallbackPlan, 'BUILD_PLAN failed'),
        wordingStage(ENGINE.templates, 'fallback', wordingMs, fallbackPlan),
      ],
    };
  }

  /**
   * EXTRACT_FROM_TRANSCRIPT; when it errors, the transcript extractor (Claude when configured, then the
   * heuristic parser) writes to Snowflake instead. Returns the extract pipeline stage.
   */
  private async extractForCapture(capture: Capture, now: Date, question: string | null): Promise<PipelineStage> {
    if (capture.transcript.trim() === '') return skippedStage('extract', 'Empty transcript');
    const started = perfNow();
    let summary: ExtractSummary;
    try {
      summary = readExtractResult(await this.repo.callExtract(capture.capture_id));
    } catch (err) {
      if (isConnectionError(err)) throw err;
      summary = { taskCount: 0, constraintCount: 0, model: null, error: errorMessage(err), tasks: [], constraints: [] };
    }
    if (summary.error === null) {
      log.info(`EXTRACT_FROM_TRANSCRIPT (${summary.model ?? 'unknown model'}): ${summary.taskCount} task(s), ${summary.constraintCount} constraint(s)`);
      return extractStage({
        engine: cortexEngine(summary.model ?? 'unknown model'),
        status: 'ok',
        ms: elapsed(started),
        tasks: summary.tasks,
        constraints: summary.constraints,
        question,
        at: now,
      });
    }

    const studentId = capture.student_id;
    const writeConstraints = summary.error !== null || summary.constraintCount === 0;
    const open = openOnly(await this.repo.openTasks(studentId), now);
    const outcome = await this.extractor.extract(capture.transcript, now, open);
    const extracted = outcome.result;
    const openById = new Map(open.map((t) => [t.task_id, t] as const));
    const realIso = this.realIso();
    const touched: ChipTask[] = [];
    for (const draft of extracted.tasks) {
      if (draft.merge_into) {
        await this.repo.mergeTask(studentId, draft.merge_into, capture.capture_id, draft);
        const target = openById.get(draft.merge_into);
        touched.push({
          normalized_text: target ? target.normalized_text : draft.normalized_text,
          due_at: draft.due_at ?? target?.due_at ?? null,
          money_at_risk: draft.money_at_risk ?? target?.money_at_risk ?? null,
        });
      } else {
        await this.repo.insertTask({
          task_id: randomUUID(),
          student_id: studentId,
          capture_id: capture.capture_id,
          raw_text: draft.raw_text,
          normalized_text: draft.normalized_text,
          category: draft.category,
          due_at: draft.due_at,
          money_at_risk: draft.money_at_risk,
          est_minutes: draft.est_minutes,
          status: 'open',
          defer_count: 0,
          created_at: toIsoLocal(now),
        });
        touched.push(draft);
      }
    }
    const written: ConstraintDraft[] = [];
    if (writeConstraints) {
      for (const c of extracted.constraints) {
        await this.repo.insertConstraint({ constraint_id: randomUUID(), capture_id: capture.capture_id, kind: c.kind, value: c.value, created_at: realIso });
        written.push(c);
        if (c.kind === 'cash') {
          const cash = readCashValue(c.value);
          if (cash) await this.repo.applyCash(studentId, cash.amount, cash.until, realIso);
        }
      }
    }
    const reason = summary.error !== null ? `error (${summary.error})` : 'no tasks';
    const message = `EXTRACT_FROM_TRANSCRIPT returned ${reason}; ${outcome.engine} wrote ${extracted.tasks.length} task(s) and ${written.length} constraint(s) to Snowflake`;
    if (summary.error !== null || extracted.tasks.length > 0) log.warn(message);
    else log.info(message);

    const cortexNote = summary.error !== null ? 'Cortex extraction failed' : 'Cortex found no tasks';
    return extractStage({
      engine: outcome.engine,
      status: 'fallback',
      ms: elapsed(started),
      tasks: touched,
      constraints: writeConstraints ? written : summary.constraints,
      question,
      at: now,
      note: outcome.note ? `${cortexNote} · ${outcome.note}` : cortexNote,
    });
  }

  private newCapture(studentId: string, transcript: string, source: CaptureSource, audioStagePath: string | null): Capture {
    return {
      capture_id: randomUUID(),
      student_id: studentId,
      audio_stage_path: audioStagePath,
      transcript,
      source,
      created_at: this.realIso(),
    };
  }

  private async captureFlow(capture: Capture, transcribe: PipelineStage): Promise<CaptureResponse> {
    const now = this.clock.now();
    const question = heuristicExtract(capture.transcript, now, []).question;
    const extract = await this.extractForCapture(capture, now, question);
    const outcome = await this.planWithFallback({
      studentId: capture.student_id,
      captureId: capture.capture_id,
      trigger: 'capture',
      context: { available_minutes: null, cash_available: null, question },
      extra: {},
      previous: null,
    });
    return {
      source: outcome.source,
      capture,
      transcript: capture.transcript,
      needs_text: false,
      tasks: outcome.tasks,
      plan: outcome.plan,
      diff: null,
      previous_plan_id: null,
      pipeline: [transcribe, extract, ...outcome.stages],
    };
  }

  private async previousPlan(req: RerankRequest): Promise<Plan> {
    const previous = (await this.repo.plan(req.student_id, req.plan_id)) ?? (await this.repo.latestPlan(req.student_id));
    if (!previous) throw new Error(`no stored plan for student ${req.student_id}`);
    return previous;
  }

  private async rerankFlow(req: RerankRequest, followup: Capture | null, transcribe: PipelineStage | null): Promise<{ response: RerankResponse; tasks: Task[] }> {
    const previous = await this.previousPlan(req);
    const extractStarted = perfNow();
    const { context, parsed } = mergeRerankContext(previous.reasoning.context, req.context);
    let extract = rerankExtractStage(req.context.question, parsed, req.context, elapsed(extractStarted));
    let captureId = previous.capture_id;
    if (followup) {
      // the follow-up capture carries the previous capture's constraints (fixed blocks, cash, time window) forward
      if (previous.capture_id && previous.capture_id !== followup.capture_id) await this.repo.copyConstraints(previous.capture_id, followup.capture_id);
      captureId = followup.capture_id;
      extract = await this.extractForCapture(followup, this.clock.now(), req.context.question ?? null);
    }
    const outcome = await this.planWithFallback({
      studentId: req.student_id,
      captureId,
      trigger: 'rerank',
      context,
      extra: {
        previous_plan_id: previous.plan_id,
        available_minutes: context.available_minutes,
        cash_available: context.cash_available,
        question: context.question,
      },
      previous,
    });
    const now = this.clock.now();
    const diff = applyDemoDiffCopy(diffPlans(previous, outcome.plan), previous, outcome.plan, outcome.tasks, { pinned: this.clock.pinned, now });
    return {
      response: {
        source: outcome.source,
        plan: outcome.plan,
        previous_plan_id: previous.plan_id,
        diff,
        pipeline: [transcribe ?? skippedStage('transcribe', 'Nothing new to transcribe'), extract, ...outcome.stages],
      },
      tasks: outcome.tasks,
    };
  }

  /**
   * preview: true. BUILD_PLAN always inserts into PLANS, so a preview runs the TypeScript ranker over Snowflake-loaded data
   * (source 'fallback') and writes nothing: no PLANS row, no expired-task update, no constraint copy.
   */
  private async previewFlow(req: RerankRequest): Promise<RerankResponse> {
    const previous = await this.previousPlan(req);
    const extractStarted = perfNow();
    const { context, parsed } = mergeRerankContext(previous.reasoning.context, req.context);
    const extract = rerankExtractStage(req.context.question, parsed, req.context, elapsed(extractStarted));
    const now = this.clock.now();
    const [tasks, timetable, profile, constraints, decay] = await Promise.all([
      this.repo.openTasks(req.student_id),
      this.repo.timetable(req.student_id),
      this.repo.profile(req.student_id),
      previous.capture_id ? this.repo.constraints(previous.capture_id) : Promise.resolve([]),
      this.repo.decay(),
    ]);
    const created = toIsoLocal(this.clock.realNow());
    const rankStarted = perfNow();
    const raw = buildPlan({
      plan_id: `preview-${randomUUID()}`,
      student_id: req.student_id,
      capture_id: previous.capture_id,
      created_at: created,
      now,
      tasks,
      timetable,
      profile: profile ?? defaultProfile(req.student_id, created),
      constraints,
      context,
      trigger: 'rerank',
      previous_plan: previous,
      decay: decayOrDefault(decay),
      model: RANKER_MODEL,
    });
    const rankMs = elapsed(rankStarted);
    const wordingStarted = perfNow();
    const plan = applyDemoCopy(raw, tasks, { pinned: this.clock.pinned, now });
    const wordingMs = elapsed(wordingStarted);
    const open = openOnly(tasks, now);
    const diff = applyDemoDiffCopy(diffPlans(previous, plan), previous, plan, open, { pinned: this.clock.pinned, now });
    return {
      source: 'fallback',
      plan,
      previous_plan_id: previous.plan_id,
      diff,
      pipeline: [
        skippedStage('transcribe', 'Nothing new to transcribe'),
        extract,
        rankStage(ENGINE.tsRanker, 'ok', rankMs, plan, 'Preview, not saved'),
        wordingStage(ENGINE.templates, 'ok', wordingMs, plan),
      ],
    };
  }

  private async followup(capture: Capture, planId: string, transcribe: PipelineStage): Promise<CaptureResponse> {
    const r = await this.rerankFlow({ student_id: capture.student_id, plan_id: planId, context: { question: capture.transcript } }, capture, transcribe);
    return {
      source: r.response.source,
      capture,
      transcript: capture.transcript,
      needs_text: false,
      tasks: r.tasks,
      plan: r.response.plan,
      diff: r.response.diff,
      previous_plan_id: r.response.previous_plan_id,
      pipeline: r.response.pipeline,
    };
  }

  /** Transcription failed or no audio: the latest stored plan (or a fresh one) with needs_text true. */
  private async needsText(capture: Capture, transcribeMs: number | null): Promise<CaptureResponse> {
    const now = this.clock.now();
    // Only name AI_TRANSCRIBE when it actually ran (transcribeMs is set); with no audio nothing transcribed.
    const transcribe =
      transcribeMs === null
        ? skippedStage('transcribe', 'No audio uploaded · type instead')
        : stage('transcribe', ENGINE.aiTranscribe, 'fallback', 'No speech recognized · type instead', transcribeMs);
    const extract = skippedStage('extract', 'Waiting for typed text');
    const latest = await this.repo.latestPlan(capture.student_id);
    if (latest) {
      const [tasks, decay] = await Promise.all([this.repo.openTasks(capture.student_id), this.repo.decay()]);
      return {
        source: 'snowflake',
        capture,
        transcript: '',
        needs_text: true,
        tasks: openOnly(tasks, now),
        plan: hydratePlan(latest, tasks, decayOrDefault(decay), now),
        diff: null,
        previous_plan_id: null,
        pipeline: [transcribe, extract, skippedStage('rank', 'Showing your last plan'), skippedStage('wording', 'Showing your last plan')],
      };
    }
    const outcome = await this.planWithFallback({
      studentId: capture.student_id,
      captureId: null,
      trigger: 'capture',
      context: { available_minutes: null, cash_available: null, question: null },
      extra: {},
      previous: null,
    });
    return {
      source: outcome.source,
      capture,
      transcript: '',
      needs_text: true,
      tasks: outcome.tasks,
      plan: outcome.plan,
      diff: null,
      previous_plan_id: null,
      pipeline: [transcribe, extract, ...outcome.stages],
    };
  }

  /** PUT the audio as capture-<uuid>.m4a and AI_TRANSCRIBE it; on failure re-PUT the same bytes as .mp4 and retry once. */
  private async transcribeUpload(studentId: string, audio: Buffer): Promise<Transcription> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pip-capture-'));
    const name = `capture-${randomUUID()}`;
    const stageDir = `${safeSegment(studentId)}/${dateOnly(this.clock.realNow())}`;
    try {
      const m4aStage = `${stageDir}/${name}.m4a`;
      const m4aFile = path.join(dir, `${name}.m4a`);
      await fs.writeFile(m4aFile, audio);
      await putFile(this.db, m4aFile, stageDir);
      try {
        return { transcript: await this.repo.transcribe(m4aStage), stagePath: m4aStage };
      } catch (err) {
        if (isConnectionError(err)) throw err;
        log.warn(`AI_TRANSCRIBE failed on ${m4aStage}, retrying as .mp4: ${errorMessage(err)}`);
      }
      const mp4Stage = `${stageDir}/${name}.mp4`;
      const mp4File = path.join(dir, `${name}.mp4`);
      await fs.writeFile(mp4File, audio);
      await putFile(this.db, mp4File, stageDir);
      try {
        return { transcript: await this.repo.transcribe(mp4Stage), stagePath: mp4Stage };
      } catch (err) {
        if (isConnectionError(err)) throw err;
        log.warn(`AI_TRANSCRIBE failed on ${mp4Stage} too; asking the student to type: ${errorMessage(err)}`);
        return { transcript: null, stagePath: m4aStage };
      }
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  // -------------------------------------------------------------------------
  // Backend
  // -------------------------------------------------------------------------

  captureText(input: CaptureTextInput): Promise<CaptureResponse> {
    return this.guard('captureText', this.timeouts.captureMs, async () => {
      const capture = this.newCapture(input.student_id, input.text.trim(), 'text', null);
      await this.repo.insertCapture(capture);
      const transcribe = transcribeStage(ENGINE.typed, 'ok', capture.transcript, null);
      if (input.followup_plan_id) return this.followup(capture, input.followup_plan_id, transcribe);
      return this.captureFlow(capture, transcribe);
    });
  }

  /**
   * AI_TRANSCRIBE first. When there is no audio, or it fails or hears nothing, the app's on-device transcript (if sent)
   * is used with the transcribe stage marked 'fallback'; without one the student is asked to type (needs_text).
   */
  captureVoice(input: CaptureVoiceInput): Promise<CaptureResponse> {
    return this.guard('captureVoice', this.timeouts.captureMs, async () => {
      const onDevice = input.client_transcript?.trim() ?? '';
      const audio = input.audio;
      let stagePath: string | null = null;
      let transcribeMs: number | null = null;
      let failure = 'No audio uploaded';
      if (audio && audio.buffer.length > 0) {
        const started = perfNow();
        const t = await this.transcribeUpload(input.student_id, audio.buffer);
        transcribeMs = elapsed(started);
        stagePath = t.stagePath;
        const transcript = t.transcript === null ? '' : t.transcript.trim();
        if (transcript !== '') {
          const capture = this.newCapture(input.student_id, transcript, 'voice', t.stagePath);
          await this.repo.insertCapture(capture);
          const transcribe = transcribeStage(ENGINE.aiTranscribe, 'ok', transcript, transcribeMs);
          if (input.followup_plan_id) return this.followup(capture, input.followup_plan_id, transcribe);
          return this.captureFlow(capture, transcribe);
        }
        failure = t.transcript === null ? 'AI_TRANSCRIBE failed' : 'AI_TRANSCRIBE heard nothing';
      }

      if (onDevice !== '') {
        log.warn(`${failure}; using the on-device transcript from the app`);
        const capture = this.newCapture(input.student_id, onDevice, 'voice', stagePath);
        await this.repo.insertCapture(capture);
        const transcribe = transcribeStage(ENGINE.onDevice, 'fallback', onDevice, transcribeMs, failure);
        if (input.followup_plan_id) return this.followup(capture, input.followup_plan_id, transcribe);
        return this.captureFlow(capture, transcribe);
      }

      if (stagePath === null) return this.needsText(this.newCapture(input.student_id, '', 'text', null), null);
      const capture = this.newCapture(input.student_id, '', 'text', stagePath);
      await this.repo.insertCapture(capture);
      return this.needsText(capture, transcribeMs);
    });
  }

  rerank(req: RerankRequest): Promise<RerankResponse> {
    return this.guard('rerank', this.timeouts.captureMs, async () => (req.preview ? this.previewFlow(req) : (await this.rerankFlow(req, null, null)).response));
  }

  timetableToday(studentId: string): Promise<TodayTimetableResponse> {
    return this.guard('timetableToday', this.timeouts.defaultMs, async () => {
      const now = this.clock.now();
      const dow = isoDow(now);
      const blocks = await this.repo.timetableForDay(studentId, dow);
      const freeWindows = computeFreeWindows(blocks, now);
      return {
        source: 'snowflake',
        student_id: studentId,
        now: toIsoLocal(now),
        day_of_week: dow,
        blocks,
        free_windows: freeWindows,
        next_free_window: freeWindows[0] ?? null,
      };
    });
  }

  timetable(studentId: string): Promise<TimetableResponse> {
    return this.guard('timetable', this.timeouts.defaultMs, async () => ({
      source: 'snowflake',
      student_id: studentId,
      blocks: await this.repo.timetable(studentId),
    }));
  }

  putTimetable(req: PutTimetableRequest): Promise<TimetableResponse> {
    return this.guard('putTimetable', this.timeouts.defaultMs, async () => {
      await this.repo.replaceTimetable(req.student_id, req.blocks);
      return { source: 'snowflake', student_id: req.student_id, blocks: await this.repo.timetable(req.student_id) };
    });
  }

  profile(studentId: string): Promise<ProfileResponse> {
    return this.guard('profile', this.timeouts.defaultMs, async () => {
      const profile = await this.repo.profile(studentId);
      if (!profile) throw new Error(`no PROFILE row for student ${studentId}`);
      return { source: 'snowflake', profile };
    });
  }

  putProfile(req: PutProfileRequest): Promise<ProfileResponse> {
    return this.guard('putProfile', this.timeouts.defaultMs, async () => {
      const updatedAt = this.realIso();
      const current = (await this.repo.profile(req.student_id)) ?? defaultProfile(req.student_id, updatedAt);
      const profile: Profile = {
        ...current,
        chronotype: req.chronotype ?? current.chronotype,
        cooks_own_meals: req.cooks_own_meals ?? current.cooks_own_meals,
        cash_available: req.cash_available ?? current.cash_available,
        budget_until: req.budget_until === undefined ? current.budget_until : req.budget_until,
        procrastinates_on: req.procrastinates_on === undefined ? current.procrastinates_on : req.procrastinates_on,
        updated_at: updatedAt,
      };
      await this.repo.mergeProfile(profile);
      return { source: 'snowflake', profile };
    });
  }

  recordAction(req: ActionRequest): Promise<ActionResponse> {
    return this.guard('recordAction', this.timeouts.defaultMs, async () => {
      const taskId = req.task_id ? req.task_id.replace(/#cont$/, '') : null;
      const raw = await this.repo.callRecordAction(req.student_id, req.plan_id, taskId, req.kind);
      const procError = procedureError(raw);
      if (procError !== null) throw new Error(`RECORD_ACTION returned error: ${procError}`);
      const action = parseAction(raw);
      const task = taskId ? await this.repo.task(req.student_id, taskId) : null;
      return { source: 'snowflake', action, task };
    });
  }

  history(studentId: string): Promise<HistoryResponse> {
    return this.guard('history', this.timeouts.defaultMs, async () => {
      const entries = await this.repo.historyEntries(studentId);
      const actions = await this.repo.historyActions(
        studentId,
        entries.map((e) => e.plan_id),
      );
      const byPlan = new Map<string, HistoryAction[]>();
      for (const a of actions) {
        const list = byPlan.get(a.plan_id) ?? [];
        list.push(a);
        byPlan.set(a.plan_id, list);
      }
      return {
        source: 'snowflake',
        student_id: studentId,
        entries: entries.map((e) => ({ ...e, actions: byPlan.get(e.plan_id) ?? [] })),
      };
    });
  }

  pivotLog(): Promise<PivotLogResponse> {
    return this.guard('pivotLog', this.timeouts.defaultMs, async () => ({ source: 'snowflake', entries: await this.repo.pivotLog() }));
  }

  createPivotLog(req: PivotLogCreateRequest): Promise<PivotLogCreateResponse> {
    return this.guard('createPivotLog', this.timeouts.defaultMs, async () => {
      const entry: PivotLogEntry = {
        entry_id: `pivot-${req.pivot_number}-${randomUUID().replace(/-/g, '').slice(0, 12)}`,
        pivot_number: req.pivot_number,
        revealed: req.revealed,
        assumption_changed: req.assumption_changed,
        response: req.response,
        cut: req.cut,
        sentence: req.sentence ?? null,
        created_at: this.realIso(),
      };
      await this.repo.insertPivot(entry);
      return { source: 'snowflake', entry };
    });
  }

  async resetDemo(studentId: string): Promise<DemoResetResponse> {
    log.warn(`POST /demo/reset in live mode does not wipe Snowflake (student ${studentId}); run "npm run seed" in api/ to restore the demo baseline.`);
    return { source: 'snowflake', ok: true };
  }

  warmPing(): Promise<WarmPingResponse> {
    return this.guard('warmPing', this.timeouts.defaultMs, async () => {
      await this.repo.ping();
      this.lastWarmPingAt = this.realIso();
      return { source: 'snowflake', ok: true };
    });
  }
}

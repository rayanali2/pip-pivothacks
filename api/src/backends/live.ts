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
import { heuristicExtract } from '../ranker/extract';
import { diffPlans } from '../ranker/diff';
import { parseContextFromQuestion } from '../ranker/questions';
import { isExpired, isOpenStatus } from '../ranker/rules';
import { computeFreeWindows } from '../ranker/windows';
import { applyDemoCopy, applyDemoDiffCopy } from '../demo/fixtures';
import { isConnectionError, putFile, SnowflakeClient, withSqlLogging, withTimeout, type SqlExecutor } from '../snowflake/client';
import { describeCortex, emptyCortexStatus, readCortexConfig, verifyCortex } from '../snowflake/cortex';
import { PipRepo, readExtractResult, type ExtractSummary } from '../snowflake/repo';
import { normalizePlanFromSnowflake, parseAction, procedureError } from '../snowflake/rows';
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
    try {
      const raw = await this.repo.callBuildPlan(req.studentId, req.captureId, { now_local: nowNtz, trigger: req.trigger, ...req.extra });
      const procError = procedureError(raw);
      if (procError !== null) throw new Error(`BUILD_PLAN returned error: ${procError}`);
      plan = normalizePlanFromSnowflake(raw);
    } catch (err) {
      if (isConnectionError(err)) throw err;
      log.warn(`BUILD_PLAN failed, building the plan with the TypeScript ranker: ${errorMessage(err)}`);
    }

    if (plan) {
      const [tasks, decay] = await Promise.all([this.repo.openTasks(req.studentId), this.repo.decay()]);
      return { plan: hydratePlan(plan, tasks, decayOrDefault(decay), now), source: 'snowflake', tasks: openOnly(tasks, now) };
    }

    const [tasks, timetable, profile, constraints, decay] = await Promise.all([
      this.repo.openTasks(req.studentId),
      this.repo.timetable(req.studentId),
      this.repo.profile(req.studentId),
      req.captureId ? this.repo.constraints(req.captureId) : Promise.resolve([]),
      this.repo.decay(),
    ]);
    const created = this.clock.realNow();
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
    const fallbackPlan = applyDemoCopy(raw, tasks, { pinned: this.clock.pinned, now });
    if (expiredTaskIds(tasks, now).length > 0) await this.repo.expireTasks(req.studentId, nowNtz);
    await this.repo.insertPlan(fallbackPlan);
    return { plan: fallbackPlan, source: 'fallback', tasks: openOnly(tasks, now) };
  }

  /** EXTRACT_FROM_TRANSCRIPT; when it errors or finds no tasks, the heuristic extractor writes to Snowflake instead. */
  private async extractForCapture(capture: Capture, now: Date): Promise<void> {
    if (capture.transcript.trim() === '') return;
    let summary: ExtractSummary;
    try {
      summary = readExtractResult(await this.repo.callExtract(capture.capture_id));
    } catch (err) {
      if (isConnectionError(err)) throw err;
      summary = { taskCount: 0, constraintCount: 0, model: null, error: errorMessage(err) };
    }
    if (summary.error === null && summary.taskCount > 0) {
      log.info(`EXTRACT_FROM_TRANSCRIPT (${summary.model ?? 'unknown model'}): ${summary.taskCount} task(s), ${summary.constraintCount} constraint(s)`);
      return;
    }

    const studentId = capture.student_id;
    const writeConstraints = summary.error !== null || summary.constraintCount === 0;
    const extracted = heuristicExtract(capture.transcript, now, openOnly(await this.repo.openTasks(studentId), now));
    const realIso = this.realIso();
    for (const draft of extracted.tasks) {
      if (draft.merge_into) {
        await this.repo.mergeTask(studentId, draft.merge_into, capture.capture_id, draft);
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
      }
    }
    let constraintCount = 0;
    if (writeConstraints) {
      for (const c of extracted.constraints) {
        await this.repo.insertConstraint({ constraint_id: randomUUID(), capture_id: capture.capture_id, kind: c.kind, value: c.value, created_at: realIso });
        constraintCount += 1;
        if (c.kind === 'cash') {
          const cash = readCashValue(c.value);
          if (cash) await this.repo.applyCash(studentId, cash.amount, cash.until, realIso);
        }
      }
    }
    const reason = summary.error !== null ? `error (${summary.error})` : 'no tasks';
    const message = `EXTRACT_FROM_TRANSCRIPT returned ${reason}; heuristic extractor wrote ${extracted.tasks.length} task(s) and ${constraintCount} constraint(s) to Snowflake`;
    if (summary.error !== null || extracted.tasks.length > 0) log.warn(message);
    else log.info(message);
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

  private async captureFlow(capture: Capture): Promise<CaptureResponse> {
    const now = this.clock.now();
    await this.extractForCapture(capture, now);
    const outcome = await this.planWithFallback({
      studentId: capture.student_id,
      captureId: capture.capture_id,
      trigger: 'capture',
      context: { available_minutes: null, cash_available: null, question: heuristicExtract(capture.transcript, now, []).question },
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
    };
  }

  private async rerankFlow(req: RerankRequest, followup: Capture | null): Promise<{ response: RerankResponse; tasks: Task[] }> {
    const previous = (await this.repo.plan(req.student_id, req.plan_id)) ?? (await this.repo.latestPlan(req.student_id));
    if (!previous) throw new Error(`no stored plan for student ${req.student_id}`);
    const prevCtx = previous.reasoning.context;
    const parsed = parseContextFromQuestion(req.context.question);
    const context: PlanContext = {
      available_minutes: req.context.available_minutes ?? parsed.available_minutes ?? prevCtx.available_minutes,
      cash_available: req.context.cash_available ?? parsed.cash_available ?? prevCtx.cash_available,
      question: req.context.question ?? prevCtx.question,
    };
    let captureId = previous.capture_id;
    if (followup) {
      // the follow-up capture carries the previous capture's constraints (fixed blocks, cash, time window) forward
      if (previous.capture_id && previous.capture_id !== followup.capture_id) await this.repo.copyConstraints(previous.capture_id, followup.capture_id);
      captureId = followup.capture_id;
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
      response: { source: outcome.source, plan: outcome.plan, previous_plan_id: previous.plan_id, diff },
      tasks: outcome.tasks,
    };
  }

  private async followup(capture: Capture, planId: string): Promise<CaptureResponse> {
    const r = await this.rerankFlow({ student_id: capture.student_id, plan_id: planId, context: { question: capture.transcript } }, capture);
    return {
      source: r.response.source,
      capture,
      transcript: capture.transcript,
      needs_text: false,
      tasks: r.tasks,
      plan: r.response.plan,
      diff: r.response.diff,
      previous_plan_id: r.response.previous_plan_id,
    };
  }

  /** Transcription failed or no audio: the latest stored plan (or a fresh one) with needs_text true. */
  private async needsText(capture: Capture): Promise<CaptureResponse> {
    const now = this.clock.now();
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
    return { source: outcome.source, capture, transcript: '', needs_text: true, tasks: outcome.tasks, plan: outcome.plan, diff: null, previous_plan_id: null };
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
      if (input.followup_plan_id) return this.followup(capture, input.followup_plan_id);
      return this.captureFlow(capture);
    });
  }

  captureVoice(input: CaptureVoiceInput): Promise<CaptureResponse> {
    return this.guard('captureVoice', this.timeouts.captureMs, async () => {
      const audio = input.audio;
      if (!audio || audio.buffer.length === 0) {
        return this.needsText(this.newCapture(input.student_id, '', 'text', null));
      }
      const t = await this.transcribeUpload(input.student_id, audio.buffer);
      const transcript = t.transcript === null ? '' : t.transcript.trim();
      if (transcript === '') {
        const capture = this.newCapture(input.student_id, '', 'text', t.stagePath);
        await this.repo.insertCapture(capture);
        return this.needsText(capture);
      }
      const capture = this.newCapture(input.student_id, transcript, 'voice', t.stagePath);
      await this.repo.insertCapture(capture);
      if (input.followup_plan_id) return this.followup(capture, input.followup_plan_id);
      return this.captureFlow(capture);
    });
  }

  rerank(req: RerankRequest): Promise<RerankResponse> {
    return this.guard('rerank', this.timeouts.captureMs, async () => (await this.rerankFlow(req, null)).response);
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

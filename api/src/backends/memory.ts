import { randomUUID } from 'node:crypto';
import type {
  Action,
  ActionRequest,
  ActionResponse,
  Capture,
  CaptureResponse,
  CaptureSource,
  Constraint,
  DecayConfig,
  DemoResetResponse,
  HealthResponse,
  HistoryAction,
  HistoryEntry,
  HistoryResponse,
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
  Student,
  Task,
  TimetableBlock,
  TimetableResponse,
  TodayTimetableResponse,
} from '../types';
import { isoDow, toIsoLocal, type Clock } from '../clock';
import { buildPlan, expiredTaskIds } from '../ranker/plan';
import { DEFAULT_DECAY_CONFIG } from '../ranker/decay';
import { diffPlans } from '../ranker/diff';
import { mergeRerankContext } from '../ranker/questions';
import { isExpired, isOpenStatus } from '../ranker/rules';
import { computeFreeWindows } from '../ranker/windows';
import { demoBaseline, DEMO_FOLLOWUP_TRANSCRIPT, DEMO_SEED_CAPTURE_ID, DEMO_STUDENT_ID, DEMO_TRANSCRIPT } from '../demo/scenario';
import { applyDemoCopy, applyDemoDiffCopy } from '../demo/fixtures';
import { createTranscriptExtractor, type ClaudeStatus, type TranscriptExtractor } from '../llm/extractor';
import {
  elapsed,
  ENGINE,
  extractStage,
  now as perfNow,
  rankStage,
  rerankExtractStage,
  skippedStage,
  transcribeStage,
  wordingStage,
  type ChipTask,
} from '../pipeline';
import type { Backend, CaptureTextInput, CaptureVoiceInput, WarmPingResponse } from './backend';

const SOURCE = 'fallback' as const;

const DEFAULT_EST_NEW: Record<Task['category'], number> = {
  class: 60,
  assignment: 120,
  errand: 30,
  meal: 30,
  money: 15,
  work: 240,
  club: 15,
  social: 60,
  rest: 480,
};

export interface MemoryBackendOptions {
  clock: Clock;
  /** reported by health() */
  snowflakeConfigured?: boolean;
  decay?: readonly DecayConfig[];
  /** transcript extraction (Claude first when configured, then the heuristic parser); default: heuristic parser only */
  extractor?: TranscriptExtractor;
}

interface StudentState {
  student: Student;
  timetable: TimetableBlock[];
  profile: Profile;
  tasks: Map<string, Task>;
  captures: Map<string, Capture>;
  constraints: Constraint[];
  /** append-only, chronological */
  plans: Plan[];
  /** constraints each plan was built with (carried forward by reranks) */
  planConstraints: Map<string, Constraint[]>;
  actions: Action[];
}

interface PlanArgs {
  capture_id: string | null;
  context: PlanContext;
  constraints: Constraint[];
  trigger: PlanTrigger;
  previous: Plan | null;
}

interface ComputedPlan {
  plan: Plan;
  /** buildPlan */
  rankMs: number;
  /** applyDemoCopy */
  wordingMs: number;
}

const clone = <T>(value: T): T => structuredClone(value);

/** In-memory store + TypeScript ranker. Serves MOCK_MODE and the live-mode fallback. Source is always 'fallback'. */
export class MemoryBackend implements Backend {
  readonly clock: Clock;
  private readonly snowflakeConfigured: boolean;
  private readonly decay: readonly DecayConfig[];
  private readonly extractor: TranscriptExtractor;
  private readonly students = new Map<string, StudentState>();
  private pivot: PivotLogEntry[];

  constructor(opts: MemoryBackendOptions) {
    this.clock = opts.clock;
    this.snowflakeConfigured = opts.snowflakeConfigured ?? false;
    this.decay = opts.decay ?? DEFAULT_DECAY_CONFIG;
    this.extractor = opts.extractor ?? createTranscriptExtractor(null);
    this.pivot = demoBaseline(this.clock.now()).pivot_log;
    this.state(DEMO_STUDENT_ID);
  }

  /** Claude extraction status for /health. */
  get claudeStatus(): ClaudeStatus {
    return this.extractor.claude;
  }

  // -------------------------------------------------------------------------
  // store helpers
  // -------------------------------------------------------------------------

  private id(prefix: string): string {
    return `${prefix}-${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  }

  private realIso(): string {
    return toIsoLocal(this.clock.realNow());
  }

  private state(studentId: string): StudentState {
    const existing = this.students.get(studentId);
    if (existing) return existing;
    const now = this.clock.now();
    const base = demoBaseline(now, studentId);
    const st: StudentState = {
      student: base.student,
      timetable: base.timetable,
      profile: base.profile,
      tasks: new Map(base.tasks.map((t) => [t.task_id, t] as const)),
      captures: new Map(),
      constraints: [],
      plans: [],
      planConstraints: new Map(),
      actions: [],
    };
    st.captures.set(DEMO_SEED_CAPTURE_ID, {
      capture_id: DEMO_SEED_CAPTURE_ID,
      student_id: studentId,
      audio_stage_path: null,
      transcript: "Demo baseline: this week's timetable and open tasks.",
      source: 'text',
      created_at: this.realIso(),
    });
    this.students.set(studentId, st);
    this.storePlan(st, { capture_id: DEMO_SEED_CAPTURE_ID, context: emptyContext(), constraints: [], trigger: 'seed', previous: null });
    return st;
  }

  private openTasks(st: StudentState, now: Date): Task[] {
    return [...st.tasks.values()].filter((t) => isOpenStatus(t) && !isExpired(t, now));
  }

  private latestPlan(st: StudentState): Plan | null {
    return st.plans[st.plans.length - 1] ?? null;
  }

  /** Pure with respect to the store: ranks and words a plan without saving it or expiring tasks. */
  private computePlan(st: StudentState, args: PlanArgs, planId: string): ComputedPlan {
    const now = this.clock.now();
    const tasks = [...st.tasks.values()];
    const rankStarted = perfNow();
    const raw = buildPlan({
      plan_id: planId,
      student_id: st.student.student_id,
      capture_id: args.capture_id,
      created_at: this.realIso(),
      now,
      tasks,
      timetable: st.timetable,
      profile: st.profile,
      constraints: args.constraints,
      context: args.context,
      trigger: args.trigger,
      previous_plan: args.previous,
      decay: this.decay,
    });
    const rankMs = elapsed(rankStarted);
    const wordingStarted = perfNow();
    const plan = applyDemoCopy(raw, tasks, { pinned: this.clock.pinned, now });
    return { plan, rankMs, wordingMs: elapsed(wordingStarted) };
  }

  private storePlan(st: StudentState, args: PlanArgs): ComputedPlan {
    const computed = this.computePlan(st, args, this.id('plan'));
    const now = this.clock.now();
    for (const id of expiredTaskIds([...st.tasks.values()], now)) {
      const t = st.tasks.get(id);
      if (t) st.tasks.set(id, { ...t, status: 'expired' });
    }
    st.plans.push(computed.plan);
    st.planConstraints.set(computed.plan.plan_id, [...args.constraints]);
    return computed;
  }

  private planStages(computed: ComputedPlan, note: string | null = null): PipelineStage[] {
    return [
      rankStage(ENGINE.tsRanker, 'ok', computed.rankMs, computed.plan, note),
      wordingStage(ENGINE.templates, 'ok', computed.wordingMs, computed.plan),
    ];
  }

  private newCapture(st: StudentState, transcript: string, source: CaptureSource): Capture {
    const capture: Capture = {
      capture_id: this.id('capture'),
      student_id: st.student.student_id,
      audio_stage_path: null,
      transcript,
      source,
      created_at: this.realIso(),
    };
    st.captures.set(capture.capture_id, capture);
    return capture;
  }

  private async captureFlow(st: StudentState, capture: Capture, transcribe: PipelineStage): Promise<CaptureResponse> {
    const now = this.clock.now();
    const outcome = await this.extractor.extract(capture.transcript, now, this.openTasks(st, now));
    const extracted = outcome.result;
    const touched: ChipTask[] = [];
    for (const draft of extracted.tasks) {
      const target = draft.merge_into ? st.tasks.get(draft.merge_into) : undefined;
      if (target) {
        const merged: Task = {
          ...target,
          due_at: draft.due_at ?? target.due_at,
          money_at_risk: draft.money_at_risk ?? target.money_at_risk,
          est_minutes: draft.est_minutes ?? target.est_minutes,
        };
        st.tasks.set(target.task_id, merged);
        touched.push(merged);
      } else {
        const task: Task = {
          task_id: this.id('task'),
          student_id: st.student.student_id,
          capture_id: capture.capture_id,
          raw_text: draft.raw_text,
          normalized_text: draft.normalized_text,
          category: draft.category,
          due_at: draft.due_at,
          money_at_risk: draft.money_at_risk,
          est_minutes: draft.est_minutes ?? DEFAULT_EST_NEW[draft.category],
          status: 'open',
          defer_count: 0,
          created_at: toIsoLocal(now),
        };
        st.tasks.set(task.task_id, task);
        touched.push(task);
      }
    }
    const constraints: Constraint[] = extracted.constraints.map((c) => ({
      constraint_id: this.id('constraint'),
      capture_id: capture.capture_id,
      kind: c.kind,
      value: c.value,
      created_at: this.realIso(),
    }));
    st.constraints.push(...constraints);

    const computed = this.storePlan(st, {
      capture_id: capture.capture_id,
      context: { available_minutes: null, cash_available: null, question: extracted.question },
      constraints,
      trigger: 'capture',
      previous: null,
    });
    const extract = extractStage({
      engine: outcome.engine,
      status: outcome.status,
      ms: outcome.ms,
      tasks: touched,
      constraints: extracted.constraints,
      question: extracted.question,
      at: now,
      note: outcome.note,
    });
    return {
      source: SOURCE,
      capture: clone(capture),
      transcript: capture.transcript,
      needs_text: false,
      tasks: clone(this.openTasks(st, this.clock.now())),
      plan: clone(computed.plan),
      diff: null,
      previous_plan_id: null,
      pipeline: [transcribe, extract, ...this.planStages(computed)],
    };
  }

  /** `transcribe` is the follow-up capture's stage (null for POST /plans/rerank). A preview persists nothing. */
  private rerankInternal(st: StudentState, req: RerankRequest, captureId: string | null, transcribe: PipelineStage | null): RerankResponse {
    const previous =
      st.plans.find((p) => p.plan_id === req.plan_id) ??
      this.latestPlan(st) ??
      this.storePlan(st, { capture_id: null, context: emptyContext(), constraints: [], trigger: 'seed', previous: null }).plan;
    const extractStarted = perfNow();
    const { context, parsed } = mergeRerankContext(previous.reasoning.context, req.context);
    const extractMs = elapsed(extractStarted);
    const args: PlanArgs = {
      capture_id: captureId ?? previous.capture_id,
      context,
      constraints: st.planConstraints.get(previous.plan_id) ?? [],
      trigger: 'rerank',
      previous,
    };
    const computed = req.preview ? this.computePlan(st, args, `preview-${randomUUID()}`) : this.storePlan(st, args);
    const plan = computed.plan;
    const now = this.clock.now();
    const tasks = [...st.tasks.values()];
    const diff = applyDemoDiffCopy(diffPlans(previous, plan), previous, plan, tasks, { pinned: this.clock.pinned, now });
    return {
      source: SOURCE,
      plan: clone(plan),
      previous_plan_id: previous.plan_id,
      diff,
      pipeline: [
        transcribe ?? skippedStage('transcribe', 'Nothing new to transcribe'),
        rerankExtractStage(req.context.question, parsed, req.context, extractMs),
        ...this.planStages(computed, req.preview ? 'Preview, not saved' : null),
      ],
    };
  }

  // -------------------------------------------------------------------------
  // Backend
  // -------------------------------------------------------------------------

  async health(_refresh: boolean): Promise<HealthResponse> {
    return {
      source: SOURCE,
      ok: true,
      mode: 'mock',
      now: toIsoLocal(this.clock.now()),
      snowflake: { configured: this.snowflakeConfigured, connected: false, error: null, last_warm_ping_at: null },
      cortex: { transcribe: null, complete: null, complete_model: null, embed: null, verified_at: null, errors: ['MOCK_MODE'] },
      claude: { ...this.extractor.claude },
    };
  }

  async captureText(input: CaptureTextInput): Promise<CaptureResponse> {
    const st = this.state(input.student_id);
    const capture = this.newCapture(st, input.text.trim(), 'text');
    const transcribe = transcribeStage(ENGINE.typed, 'ok', capture.transcript, null);
    if (input.followup_plan_id) return this.followup(st, capture, input.followup_plan_id, transcribe);
    return this.captureFlow(st, capture, transcribe);
  }

  async captureVoice(input: CaptureVoiceInput): Promise<CaptureResponse> {
    const st = this.state(input.student_id);
    const started = perfNow();
    // Mock transcription ignores the audio: the app's on-device transcript when it sent one, else the canned demo transcript.
    const onDevice = input.client_transcript?.trim() ?? '';
    let transcribe: PipelineStage;
    let transcript: string;
    if (onDevice !== '') {
      transcript = onDevice;
      transcribe = transcribeStage(ENGINE.onDevice, 'ok', transcript, null);
    } else {
      transcript = input.followup_plan_id ? DEMO_FOLLOWUP_TRANSCRIPT : DEMO_TRANSCRIPT;
      transcribe = transcribeStage(ENGINE.demoTranscript, 'ok', transcript, elapsed(started));
    }
    const capture = this.newCapture(st, transcript, 'voice');
    if (input.followup_plan_id) return this.followup(st, capture, input.followup_plan_id, transcribe);
    return this.captureFlow(st, capture, transcribe);
  }

  private followup(st: StudentState, capture: Capture, planId: string, transcribe: PipelineStage): CaptureResponse {
    const r = this.rerankInternal(
      st,
      { student_id: st.student.student_id, plan_id: planId, context: { question: capture.transcript } },
      capture.capture_id,
      transcribe,
    );
    return {
      source: SOURCE,
      capture: clone(capture),
      transcript: capture.transcript,
      needs_text: false,
      tasks: clone(this.openTasks(st, this.clock.now())),
      plan: r.plan,
      diff: r.diff,
      previous_plan_id: r.previous_plan_id,
      pipeline: r.pipeline,
    };
  }

  async rerank(req: RerankRequest): Promise<RerankResponse> {
    return this.rerankInternal(this.state(req.student_id), req, null, null);
  }

  async timetableToday(studentId: string): Promise<TodayTimetableResponse> {
    const st = this.state(studentId);
    const now = this.clock.now();
    const dow = isoDow(now);
    const blocks = st.timetable.filter((b) => b.day_of_week === dow).sort((a, b) => a.starts_at.localeCompare(b.starts_at));
    const freeWindows = computeFreeWindows(blocks, now);
    return {
      source: SOURCE,
      student_id: studentId,
      now: toIsoLocal(now),
      day_of_week: dow,
      blocks: clone(blocks),
      free_windows: freeWindows,
      next_free_window: freeWindows[0] ?? null,
    };
  }

  async timetable(studentId: string): Promise<TimetableResponse> {
    const st = this.state(studentId);
    return { source: SOURCE, student_id: studentId, blocks: clone(sortWeek(st.timetable)) };
  }

  async putTimetable(req: PutTimetableRequest): Promise<TimetableResponse> {
    const st = this.state(req.student_id);
    st.timetable = sortWeek(req.blocks.map((b) => ({ ...b, student_id: req.student_id, location: b.location ?? null })));
    return { source: SOURCE, student_id: req.student_id, blocks: clone(st.timetable) };
  }

  async profile(studentId: string): Promise<ProfileResponse> {
    return { source: SOURCE, profile: clone(this.state(studentId).profile) };
  }

  async putProfile(req: PutProfileRequest): Promise<ProfileResponse> {
    const st = this.state(req.student_id);
    const p = st.profile;
    st.profile = {
      ...p,
      chronotype: req.chronotype ?? p.chronotype,
      cooks_own_meals: req.cooks_own_meals ?? p.cooks_own_meals,
      cash_available: req.cash_available ?? p.cash_available,
      budget_until: req.budget_until === undefined ? p.budget_until : req.budget_until,
      procrastinates_on: req.procrastinates_on === undefined ? p.procrastinates_on : req.procrastinates_on,
      updated_at: this.realIso(),
    };
    return { source: SOURCE, profile: clone(st.profile) };
  }

  async recordAction(req: ActionRequest): Promise<ActionResponse> {
    const st = this.state(req.student_id);
    const plan = st.plans.find((p) => p.plan_id === req.plan_id) ?? this.latestPlan(st);
    const taskId = req.task_id ? req.task_id.replace(/#cont$/, '') : null;
    let task = taskId ? (st.tasks.get(taskId) ?? null) : null;
    if (task) {
      if (req.kind === 'done') task = { ...task, status: 'done' };
      else if (req.kind === 'defer') task = { ...task, status: 'deferred', defer_count: task.defer_count + 1 };
      else if (req.kind === 'drop') task = { ...task, status: 'dropped' };
      st.tasks.set(task.task_id, task);
    }
    const action: Action = {
      action_id: this.id('action'),
      student_id: req.student_id,
      plan_id: plan ? plan.plan_id : req.plan_id,
      task_id: taskId,
      kind: req.kind,
      created_at: this.realIso(),
    };
    st.actions.push(action);
    return { source: SOURCE, action: clone(action), task: task ? clone(task) : null };
  }

  async history(studentId: string): Promise<HistoryResponse> {
    const st = this.state(studentId);
    const entries: HistoryEntry[] = st.plans.map((plan, i) => {
      const prevId = plan.reasoning.previous_plan_id;
      const prev = (prevId ? st.plans.find((p) => p.plan_id === prevId) : undefined) ?? (i > 0 ? st.plans[i - 1] : undefined) ?? null;
      const doNowTitle = plan.do_now ? plan.do_now.title : null;
      const prevTitle = prev?.do_now ? prev.do_now.title : null;
      let changed: string;
      if (!prev) changed = 'first plan';
      else if ((prev.do_now?.item_id ?? null) === (plan.do_now?.item_id ?? null)) changed = 'same do now';
      else changed = `do now: ${prevTitle ?? 'nothing'} → ${doNowTitle ?? 'nothing'}`;

      const capture = plan.capture_id ? st.captures.get(plan.capture_id) : undefined;
      let transcript: string | null = null;
      if (plan.reasoning.trigger === 'rerank') transcript = plan.reasoning.context.question;
      else if (plan.reasoning.trigger === 'capture') transcript = capture ? capture.transcript : null;

      const actions: HistoryAction[] = st.actions
        .filter((a) => a.plan_id === plan.plan_id)
        .reverse()
        .map((a) => ({ ...a, task_title: this.taskTitle(st, plan, a.task_id) }));

      return {
        plan_id: plan.plan_id,
        capture_id: plan.capture_id,
        created_at: plan.created_at,
        model: plan.model,
        trigger: plan.reasoning.trigger,
        transcript,
        context: { ...plan.reasoning.context },
        do_now_task_id: plan.do_now ? plan.do_now.task_id : null,
        do_now_title: doNowTitle,
        previous_do_now_title: prev ? prevTitle : null,
        changed,
        actions,
      };
    });
    return { source: SOURCE, student_id: studentId, entries: entries.reverse() };
  }

  private taskTitle(st: StudentState, plan: Plan, taskId: string | null): string | null {
    if (!taskId) return null;
    const items = [plan.do_now, plan.next, ...plan.today, ...plan.can_wait];
    const item = items.find((x) => x !== null && x.item_id === taskId) ?? items.find((x) => x !== null && x.task_id === taskId);
    if (item) return item.title;
    return st.tasks.get(taskId)?.normalized_text ?? null;
  }

  async pivotLog(): Promise<PivotLogResponse> {
    const entries = [...this.pivot].sort((a, b) => a.pivot_number - b.pivot_number || a.created_at.localeCompare(b.created_at));
    return { source: SOURCE, entries: clone(entries) };
  }

  async createPivotLog(req: PivotLogCreateRequest): Promise<PivotLogCreateResponse> {
    const entry: PivotLogEntry = {
      entry_id: this.id(`pivot-${req.pivot_number}`),
      pivot_number: req.pivot_number,
      revealed: req.revealed,
      assumption_changed: req.assumption_changed,
      response: req.response,
      cut: req.cut,
      sentence: req.sentence ?? null,
      created_at: this.realIso(),
    };
    this.pivot.push(entry);
    return { source: SOURCE, entry: clone(entry) };
  }

  /** Resets that student's tasks, timetable, profile, captures, plans and actions to the demo baseline (the pivot log is kept). */
  async resetDemo(studentId: string): Promise<DemoResetResponse> {
    this.students.delete(studentId);
    this.state(studentId);
    return { source: SOURCE, ok: true };
  }

  async warmPing(): Promise<WarmPingResponse> {
    return { source: SOURCE, ok: true };
  }
}

function emptyContext(): PlanContext {
  return { available_minutes: null, cash_available: null, question: null };
}

function sortWeek(blocks: TimetableBlock[]): TimetableBlock[] {
  return [...blocks].sort((a, b) => a.day_of_week - b.day_of_week || a.starts_at.localeCompare(b.starts_at));
}

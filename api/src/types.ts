// UniMate API contract — the single source of truth shared by:
//   api/        (these types, verbatim)
//   snowflake/  (BUILD_PLAN / EXTRACT_FROM_TRANSCRIPT / RECORD_ACTION return these JSON shapes)
//   ios/        (Codable models decode these with .convertFromSnakeCase)
// See docs/CONTRACT.md for semantics, the ranker spec and the demo data.

export const CATEGORIES = ['class', 'assignment', 'errand', 'meal', 'money', 'work', 'club', 'social', 'rest'] as const;
export type Category = (typeof CATEGORIES)[number];

export const TASK_STATUSES = ['open', 'done', 'deferred', 'dropped', 'expired'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const CONSTRAINT_KINDS = ['time_window', 'cash', 'fixed_block', 'travel'] as const;
export type ConstraintKind = (typeof CONSTRAINT_KINDS)[number];

export const ACTION_KINDS = ['start_now', 'done', 'defer', 'drop'] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

export const RULE_IDS = [
  'irreversible_loss', // 1. irreversible deadline or money loss
  'fixed_block_collision', // 2. collision with a fixed class/lab block
  'basic_needs', // 3. basic needs / ability to function today
  'fits_window', // 4. a useful first step fits the available window
  'academic_deadline', // 5. near academic deadline / blocks other work
] as const;
export type RuleId = (typeof RULE_IDS)[number];

export const CHRONOTYPES = ['early_bird', 'neutral', 'night_owl'] as const;
export type Chronotype = (typeof CHRONOTYPES)[number];

export const DECAY_CURVES = ['cliff', 'linear', 'daily_reset', 'rising_floor', 'defer_multiplier'] as const;
export type DecayCurve = (typeof DECAY_CURVES)[number];

/** 'snowflake' = served by Snowflake/Cortex. 'fallback' = in-memory store and/or TypeScript ranker (also used by MOCK_MODE). */
export type Source = 'snowflake' | 'fallback';
export type CaptureSource = 'voice' | 'text';

/** Local wall-clock time with numeric offset, no fractional seconds: 2026-09-14T17:00:00-07:00 */
export type IsoDateTime = string;
/** 2026-09-18 */
export type IsoDate = string;
/** 24h "HH:MM", e.g. "14:00" */
export type TimeOfDay = string;

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

export interface Student {
  student_id: string;
  created_at: IsoDateTime;
}

export interface TimetableBlock {
  student_id: string;
  /** ISO day of week: 1 = Monday … 7 = Sunday (Snowflake DAYOFWEEKISO) */
  day_of_week: number;
  title: string;
  starts_at: TimeOfDay;
  ends_at: TimeOfDay;
  location: string | null;
}

export interface Profile {
  student_id: string;
  chronotype: Chronotype;
  cooks_own_meals: boolean;
  cash_available: number;
  budget_until: IsoDate | null;
  procrastinates_on: Category | null;
  updated_at: IsoDateTime;
}

export interface Capture {
  capture_id: string;
  student_id: string;
  audio_stage_path: string | null;
  transcript: string;
  source: CaptureSource;
  created_at: IsoDateTime;
}

export interface Task {
  task_id: string;
  student_id: string;
  capture_id: string | null;
  raw_text: string;
  normalized_text: string;
  category: Category;
  due_at: IsoDateTime | null;
  money_at_risk: number | null;
  est_minutes: number | null;
  status: TaskStatus;
  defer_count: number;
  created_at: IsoDateTime;
}

export interface Constraint {
  constraint_id: string;
  capture_id: string;
  kind: ConstraintKind;
  /** time_window: {minutes} | cash: {amount, until} | fixed_block: {title, starts_at, ends_at, location} | travel: {minutes, to} */
  value: JsonValue;
  created_at: IsoDateTime;
}

export interface DecayConfig {
  category: Category;
  curve: DecayCurve;
  half_life_hours: number;
  floor_weight: number;
}

export interface Action {
  action_id: string;
  student_id: string;
  plan_id: string;
  task_id: string | null;
  kind: ActionKind;
  created_at: IsoDateTime;
}

export interface PivotLogEntry {
  entry_id: string;
  pivot_number: number;
  revealed: string;
  assumption_changed: string;
  response: string;
  cut: string;
  sentence: string | null;
  created_at: IsoDateTime;
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

export interface RuleEvidence {
  rule: RuleId;
  label: string;
  fired: boolean;
  /** one short sentence with the actual numbers, e.g. "Refund of $79 is lost at 5:00 PM (3 h 47 min away)." */
  detail: string;
}

export interface CurvePoint {
  /** hours of postponement from plan time */
  hours: number;
  /** relative cost of postponing, 0…1 */
  cost: number;
}

export type PlanSection = 'do_now' | 'next' | 'today' | 'can_wait';
export type PlanItemKind = 'task' | 'fixed_block' | 'guard';
export type PlanItemFlag = 'at_risk' | 'balance_guard';

export interface PlanItem {
  /** task_id for tasks; `${task_id}#cont` for a continuation session; `block:${day_of_week}:${HH:MM}` for fixed blocks; `guard:${category}` for guards */
  item_id: string;
  kind: PlanItemKind;
  task_id: string | null;
  /** short noun phrase, e.g. "Return headphones" */
  title: string;
  /** the smallest concrete action, e.g. "Grab the headphones and receipt and head to the store now (~35 min)" */
  action: string;
  category: Category | null;
  /** exactly one plain sentence citing the real numbers (deadline time, dollars, free minutes before next block) */
  why: string;
  starts_at: IsoDateTime | null;
  ends_at: IsoDateTime | null;
  est_minutes: number | null;
  due_at: IsoDateTime | null;
  money_at_risk: number | null;
  location: string | null;
  flag: PlanItemFlag | null;
  rules_fired: RuleId[];
  /** always 5 entries (one per RuleId, in RULE_IDS order) for kind 'task'; [] otherwise */
  evidence: RuleEvidence[];
  /** cost-of-delay curve, [] for fixed blocks */
  curve: CurvePoint[];
  curve_kind: DecayCurve | null;
}

export interface FreeWindow {
  starts_at: IsoDateTime;
  ends_at: IsoDateTime;
  minutes: number;
  next_block_title: string | null;
  next_block_starts_at: IsoDateTime | null;
  /** "47 min free until CHEM 110 Lab, 2:00 PM" */
  label: string;
}

export interface PlanContext {
  available_minutes: number | null;
  cash_available: number | null;
  question: string | null;
}

export interface PlanWarning {
  task_id: string | null;
  text: string;
}

export interface PreRankEntry {
  task_id: string;
  score: number;
  rules_fired: RuleId[];
  first_step_minutes: number;
  fits: boolean;
}

export type PlanTrigger = 'capture' | 'rerank' | 'seed';

export interface PlanReasoning {
  /** 1–2 sentences UniMate can speak as an overview */
  summary: string;
  /** the scenario clock the plan was computed for */
  now: IsoDateTime;
  free_window: FreeWindow | null;
  /** min(free_window.minutes, context.available_minutes) */
  effective_minutes: number;
  context: PlanContext;
  cash_available: number;
  budget_until: IsoDate | null;
  days_until_budget: number | null;
  daily_budget: number | null;
  warnings: PlanWarning[];
  /** human sentences for basic needs surfaced by the 36h balance guard */
  balance_guard: string[];
  /** answer to context.question, if any */
  answer: string | null;
  pre_rank: PreRankEntry[];
  trigger: PlanTrigger;
  previous_plan_id: string | null;
}

export interface Plan {
  plan_id: string;
  student_id: string;
  capture_id: string | null;
  created_at: IsoDateTime;
  /** e.g. "claude-sonnet-4-5", "mistral-large2", "sql-prerank", "deterministic-ranker-v1" */
  model: string;
  do_now: PlanItem | null;
  next: PlanItem | null;
  today: PlanItem[];
  can_wait: PlanItem[];
  reasoning: PlanReasoning;
}

export interface PlanMove {
  item_id: string;
  title: string;
  from: PlanSection | null;
  to: PlanSection | null;
  from_index: number | null;
  to_index: number | null;
  reason: string;
}

export interface PlanDiff {
  /** one line for the "what changed" banner */
  headline: string;
  do_now_changed: boolean;
  previous_do_now_title: string | null;
  moves: PlanMove[];
}

export interface HistoryAction extends Action {
  task_title: string | null;
}

export interface HistoryEntry {
  plan_id: string;
  capture_id: string | null;
  created_at: IsoDateTime;
  model: string;
  trigger: PlanTrigger;
  transcript: string | null;
  context: PlanContext | null;
  do_now_task_id: string | null;
  do_now_title: string | null;
  previous_do_now_title: string | null;
  /** "do now: Return headphones → Outline the assignment" or "first plan" */
  changed: string;
  actions: HistoryAction[];
}

export interface CortexStatus {
  /** e.g. "AI_TRANSCRIBE" or null if not verified */
  transcribe: string | null;
  /** e.g. "AI_COMPLETE" | "SNOWFLAKE.CORTEX.COMPLETE" */
  complete: string | null;
  complete_model: string | null;
  /** e.g. "AI_EMBED" | "SNOWFLAKE.CORTEX.EMBED_TEXT_768" */
  embed: string | null;
  verified_at: IsoDateTime | null;
  errors: string[];
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

export interface Sourced {
  source: Source;
}

export interface ErrorResponse extends Sourced {
  error: string;
}

export interface HealthResponse extends Sourced {
  ok: true;
  mode: 'live' | 'mock';
  now: IsoDateTime;
  snowflake: {
    configured: boolean;
    connected: boolean;
    error: string | null;
    last_warm_ping_at: IsoDateTime | null;
  };
  cortex: CortexStatus;
}

export interface CaptureTextRequest {
  student_id: string;
  text: string;
}

/** POST /captures/voice is multipart: fields student_id, optional followup_plan_id; file field "audio" (m4a). */
export interface CaptureResponse extends Sourced {
  capture: Capture;
  transcript: string;
  /** true when transcription failed; the app should ask the student to type */
  needs_text: boolean;
  /** all open tasks the plan was built from */
  tasks: Task[];
  plan: Plan;
  /** set when this capture was a follow-up (followup_plan_id) */
  diff: PlanDiff | null;
  previous_plan_id: string | null;
}

export interface RerankRequest {
  student_id: string;
  plan_id: string;
  context: {
    available_minutes?: number;
    cash_available?: number;
    question?: string;
  };
}

export interface RerankResponse extends Sourced {
  plan: Plan;
  previous_plan_id: string;
  diff: PlanDiff;
}

export interface TodayTimetableResponse extends Sourced {
  student_id: string;
  now: IsoDateTime;
  day_of_week: number;
  blocks: TimetableBlock[];
  free_windows: FreeWindow[];
  next_free_window: FreeWindow | null;
}

export interface TimetableResponse extends Sourced {
  student_id: string;
  blocks: TimetableBlock[];
}

export interface PutTimetableRequest {
  student_id: string;
  blocks: Array<Omit<TimetableBlock, 'student_id'>>;
}

export interface ProfileResponse extends Sourced {
  profile: Profile;
}

export interface PutProfileRequest {
  student_id: string;
  chronotype?: Chronotype;
  cooks_own_meals?: boolean;
  cash_available?: number;
  budget_until?: IsoDate | null;
  procrastinates_on?: Category | null;
}

export interface ActionRequest {
  student_id: string;
  plan_id: string;
  task_id: string | null;
  kind: ActionKind;
}

export interface ActionResponse extends Sourced {
  action: Action;
  task: Task | null;
}

export interface HistoryResponse extends Sourced {
  student_id: string;
  entries: HistoryEntry[];
}

export interface PivotLogResponse extends Sourced {
  entries: PivotLogEntry[];
}

export interface PivotLogCreateRequest {
  pivot_number: number;
  revealed: string;
  assumption_changed: string;
  response: string;
  cut: string;
  sentence?: string | null;
}

export interface PivotLogCreateResponse extends Sourced {
  entry: PivotLogEntry;
}

export interface DemoResetResponse extends Sourced {
  ok: true;
}

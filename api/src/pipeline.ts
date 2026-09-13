import { performance } from 'node:perf_hooks';
import type { ConstraintKind, JsonValue, PipelineChip, PipelineStage, PipelineStageId, PipelineStageStatus, Plan } from './types';
import { calendarDaysBetween, formatDay, formatTime, parseDateOnly, parseTimeOfDay, tryParseIsoLocal, WEEKDAY_NAMES } from './clock';
import type { ParsedQuestionContext } from './ranker/questions';
import { dollars, plural } from './ranker/text';

// Pipeline trace builders (CONTRACT section 3, "Pipeline trace"). Engine strings name what actually ran:
// never label work as Snowflake, Cortex or Claude unless that engine produced it.

export const STAGE_LABELS: Readonly<Record<PipelineStageId, string>> = {
  transcribe: 'Heard you',
  extract: 'Pulled out tasks',
  rank: 'Ranked against 5 rules',
  wording: 'Wrote your plan',
};

export const ENGINE = {
  aiTranscribe: 'Snowflake AI_TRANSCRIBE',
  onDevice: 'On-device speech (iOS)',
  typed: 'Typed',
  demoTranscript: 'Demo transcript (mock mode)',
  heuristic: 'Heuristic parser',
  sqlPreRank: 'Snowflake SQL pre-rank',
  tsRanker: 'Deterministic 5-rule ranker',
  sqlNoLlm: 'Snowflake SQL pre-rank (no LLM)',
  templates: 'Templates',
  /** engine of a skipped stage */
  notNeeded: 'Not needed',
} as const;

/** Plan.model when BUILD_PLAN wrote no LLM wording */
export const SQL_PRERANK_MODEL = 'sql-prerank';

export function cortexEngine(model: string): string {
  return `Snowflake Cortex · ${model}`;
}

export function claudeEngine(model: string): string {
  return `Claude · ${model}`;
}

/** Milliseconds since `started` (a performance.now() reading), rounded. */
export function elapsed(started: number): number {
  return Math.max(0, Math.round(performance.now() - started));
}

export function now(): number {
  return performance.now();
}

export function stage(
  id: PipelineStageId,
  engine: string,
  status: PipelineStageStatus,
  detail: string,
  ms: number | null,
  chips: PipelineChip[] = [],
): PipelineStage {
  return { id, label: STAGE_LABELS[id], engine, detail, status, ms: ms === null ? null : Math.max(0, Math.round(ms)), chips };
}

export function skippedStage(id: PipelineStageId, detail: string): PipelineStage {
  return stage(id, ENGINE.notNeeded, 'skipped', detail, null);
}

function withNote(note: string | null | undefined, detail: string): string {
  return note ? `${note} · ${detail}` : detail;
}

export function wordCount(text: string): number {
  const t = text.trim();
  return t === '' ? 0 : t.split(/\s+/).length;
}

// ---------------------------------------------------------------------------
// Chips
// ---------------------------------------------------------------------------

export interface ChipTask {
  normalized_text: string;
  money_at_risk: number | null;
  due_at: string | null;
}

export interface ChipConstraint {
  kind: ConstraintKind;
  value: JsonValue;
}

function asObject(value: JsonValue): { [key: string]: JsonValue } | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

/** "5:00 PM" when due today, "tomorrow", "Friday", "next Friday", "Sep 25" */
function dueHint(dueAt: string | null, at: Date): string | null {
  if (!dueAt) return null;
  const due = tryParseIsoLocal(dueAt);
  if (!due) return null;
  return calendarDaysBetween(at, due) === 0 ? formatTime(due) : formatDay(due, at);
}

/** "today", "tomorrow", "Fri" (within 6 days), "next Friday", "Sep 25" */
function shortDay(day: Date, at: Date): string {
  const days = calendarDaysBetween(at, day);
  if (days > 1 && days < 7) return (WEEKDAY_NAMES[day.getDay()] ?? '').slice(0, 3);
  return formatDay(day, at);
}

/** "Return headphones for refund · $79 · 5:00 PM" */
export function taskChip(task: ChipTask, at: Date): PipelineChip {
  const title = task.normalized_text.trim();
  const parts = [title === '' ? 'Task' : title];
  if (task.money_at_risk !== null && task.money_at_risk > 0) parts.push(dollars(task.money_at_risk));
  const due = dueHint(task.due_at, at);
  if (due) parts.push(due);
  return { kind: 'task', label: parts.join(' · ') };
}

/** "Lab 2:00 PM", "$35 until Fri", "25 min free", "15 min travel to campus"; null for an unreadable value */
export function constraintChip(c: ChipConstraint, at: Date): PipelineChip | null {
  const o = asObject(c.value);
  if (!o) return null;
  if (c.kind === 'fixed_block') {
    const title = typeof o.title === 'string' && o.title.trim() !== '' ? o.title.trim() : 'Class';
    const start = typeof o.starts_at === 'string' ? parseTimeOfDay(o.starts_at) : null;
    if (!start) return { kind: 'fixed_block', label: title };
    const startDate = new Date(at.getFullYear(), at.getMonth(), at.getDate(), start.h, start.m, 0, 0);
    return { kind: 'fixed_block', label: `${title} ${formatTime(startDate)}` };
  }
  if (c.kind === 'cash') {
    if (typeof o.amount !== 'number' || !Number.isFinite(o.amount)) return null;
    const until = typeof o.until === 'string' ? parseDateOnly(o.until) : null;
    return { kind: 'cash', label: until ? `${dollars(o.amount)} until ${shortDay(until, at)}` : `${dollars(o.amount)} cash` };
  }
  if (typeof o.minutes !== 'number' || !Number.isFinite(o.minutes)) return null;
  const minutes = Math.round(o.minutes);
  if (c.kind === 'time_window') return { kind: 'time_window', label: `${minutes} min free` };
  const to = typeof o.to === 'string' && o.to.trim() !== '' ? ` to ${o.to.trim()}` : '';
  return { kind: 'travel', label: `${minutes} min travel${to}` };
}

export function questionChip(question: string): PipelineChip {
  const q = question.trim();
  return { kind: 'question', label: q.length > 80 ? `${q.slice(0, 77)}...` : q };
}

// ---------------------------------------------------------------------------
// Stages
// ---------------------------------------------------------------------------

/** detail: "34 words", or "AI_TRANSCRIBE heard nothing · 34 words" with a note */
export function transcribeStage(engine: string, status: PipelineStageStatus, transcript: string, ms: number | null, note: string | null = null): PipelineStage {
  return stage('transcribe', engine, status, withNote(note, plural(wordCount(transcript), 'word')), ms);
}

export interface ExtractStageInput {
  engine: string;
  status: PipelineStageStatus;
  ms: number | null;
  /** extracted tasks as stored after merging (one chip each) */
  tasks: readonly ChipTask[];
  constraints: readonly ChipConstraint[];
  question: string | null;
  at: Date;
  note?: string | null;
}

/** detail: "3 tasks · 2 constraints"; chips: one per task, one per readable constraint, one for the question */
export function extractStage(input: ExtractStageInput): PipelineStage {
  const chips: PipelineChip[] = input.tasks.map((t) => taskChip(t, input.at));
  for (const c of input.constraints) {
    const chip = constraintChip(c, input.at);
    if (chip) chips.push(chip);
  }
  if (input.question) chips.push(questionChip(input.question));
  const detail = `${plural(input.tasks.length, 'task')} · ${plural(input.constraints.length, 'constraint')}`;
  return stage('extract', input.engine, input.status, withNote(input.note, detail), input.ms, chips);
}

/** Rerank extract stage: minutes and cash parsed from the question, or skipped when there is no question. */
export function rerankExtractStage(
  question: string | undefined,
  parsed: ParsedQuestionContext,
  explicit: { available_minutes?: number; cash_available?: number },
  ms: number | null,
): PipelineStage {
  const direct: string[] = [];
  if (explicit.available_minutes !== undefined) direct.push(`${explicit.available_minutes} min`);
  if (explicit.cash_available !== undefined) direct.push(dollars(explicit.cash_available));
  if (!question) return skippedStage('extract', direct.length > 0 ? `No question · set directly: ${direct.join(' · ')}` : 'No question to parse');

  const chips: PipelineChip[] = [];
  const found: string[] = [];
  if (parsed.available_minutes !== null) {
    chips.push({ kind: 'time_window', label: `${parsed.available_minutes} min free` });
    found.push(`${parsed.available_minutes} min`);
  }
  if (parsed.cash_available !== null) {
    chips.push({ kind: 'cash', label: `${dollars(parsed.cash_available)} cash` });
    found.push(dollars(parsed.cash_available));
  }
  chips.push(questionChip(question));
  let detail = found.length > 0 ? `Parsed ${found.join(' · ')} from your question` : 'No minutes or cash in the question';
  if (direct.length > 0) detail += ` · set directly: ${direct.join(' · ')}`;
  return stage('extract', ENGINE.heuristic, 'ok', detail, ms, chips);
}

/** detail: "6 tasks scored · do now: Return headphones" */
export function rankStage(engine: string, status: PipelineStageStatus, ms: number | null, plan: Plan, note: string | null = null): PipelineStage {
  const doNow = plan.do_now ? `do now: ${plan.do_now.title}` : 'nothing fits right now';
  return stage('rank', engine, status, withNote(note, `${plural(plan.reasoning.pre_rank.length, 'task')} scored · ${doNow}`), ms);
}

export function planItemCount(plan: Plan): number {
  return (plan.do_now ? 1 : 0) + (plan.next ? 1 : 0) + plan.today.length + plan.can_wait.length;
}

/** detail: "9 items + summary" */
export function wordingStage(engine: string, status: PipelineStageStatus, ms: number | null, plan: Plan, note: string | null = null): PipelineStage {
  return stage('wording', engine, status, withNote(note, `${plural(planItemCount(plan), 'item')} + summary`), ms);
}

/** Wording engine of a BUILD_PLAN plan: Cortex model, or the SQL pre-rank when no LLM wrote it. */
export function snowflakeWordingEngine(model: string): string {
  return model === SQL_PRERANK_MODEL ? ENGINE.sqlNoLlm : cortexEngine(model);
}

/**
 * PipService answered from the in-memory backend after the live backend failed: every stage that ran is marked
 * 'fallback' and the first stage's detail starts with the reason ("Snowflake unavailable · ...").
 */
export function markPipelineFallback(pipeline: readonly PipelineStage[], reason: string): PipelineStage[] {
  return pipeline.map((s, i) => ({
    ...s,
    status: s.status === 'skipped' ? s.status : 'fallback',
    detail: i === 0 ? withNote(reason, s.detail) : s.detail,
    chips: [...s.chips],
  }));
}

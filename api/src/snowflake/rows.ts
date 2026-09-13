import { z } from 'zod';
import type { Action, IsoDateTime, JsonValue, Plan, PlanContext } from '../types';
import { ACTION_KINDS, CATEGORIES, DECAY_CURVES, RULE_IDS } from '../types';
import { ntzToIsoLocal } from '../clock';
import { log } from '../log';

/** One snowflake-sdk result row (object row mode). Column keys are upper case unless aliased otherwise. */
export type Row = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Narrowing helpers
// ---------------------------------------------------------------------------

export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function kindOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/** Cell by exact key, falling back to a case-insensitive match (PUT results use lower-case keys). */
export function cell(row: Row, col: string): unknown {
  if (Object.prototype.hasOwnProperty.call(row, col)) return row[col];
  const lower = col.toLowerCase();
  for (const [key, value] of Object.entries(row)) {
    if (key.toLowerCase() === lower) return value;
  }
  return undefined;
}

export function str(row: Row, col: string): string {
  const v = cell(row, col);
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v);
  throw new Error(`column ${col}: expected a string, got ${kindOf(v)}`);
}

export function strOrNull(row: Row, col: string): string | null {
  const v = cell(row, col);
  return v === null || v === undefined ? null : str(row, col);
}

function toNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export function num(row: Row, col: string): number {
  const v = cell(row, col);
  const n = toNumber(v);
  if (n === null) throw new Error(`column ${col}: expected a number, got ${kindOf(v)}`);
  return n;
}

export function numOrNull(row: Row, col: string): number | null {
  const v = cell(row, col);
  return v === null || v === undefined ? null : num(row, col);
}

export function bool(row: Row, col: string): boolean {
  const v = cell(row, col);
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') {
    const t = v.trim().toLowerCase();
    if (t === 'true' || t === '1') return true;
    if (t === 'false' || t === '0') return false;
  }
  throw new Error(`column ${col}: expected a boolean, got ${kindOf(v)}`);
}

/** VARIANT values normally arrive parsed; be defensive and parse JSON strings too. */
export function parseVariant(value: unknown): unknown {
  if (value === undefined) return null;
  if (typeof value === 'string') {
    const t = value.trim();
    if (t.startsWith('{') || t.startsWith('[') || t === 'null') {
      try {
        const parsed: unknown = JSON.parse(t);
        return parsed;
      } catch {
        return value;
      }
    }
  }
  return value;
}

export function json(row: Row, col: string): unknown {
  return parseVariant(cell(row, col));
}

export function toJsonValue(value: unknown): JsonValue {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') return Number(value);
  if (Array.isArray(value)) return value.map((x: unknown) => toJsonValue(x));
  const rec = asRecord(value);
  if (!rec) return null;
  const out: { [key: string]: JsonValue } = {};
  for (const [k, v] of Object.entries(rec)) out[k] = toJsonValue(v);
  return out;
}

export function isOneOf<T extends string>(values: readonly T[], value: string): value is T {
  return values.some((v) => v === value);
}

export function oneOf<T extends string>(values: readonly T[], value: string | null, fallback: T): T {
  return value !== null && isOneOf(values, value) ? value : fallback;
}

// ---------------------------------------------------------------------------
// Datetimes
// ---------------------------------------------------------------------------

const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const NTZ = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/;

/** NTZ local wall time -> IsoDateTime with the local offset. Strings that already carry an offset are left alone. */
export function withOffset(value: string): IsoDateTime {
  const t = value.trim();
  if (ISO_WITH_OFFSET.test(t)) return t;
  return ntzToIsoLocal(t);
}

export function ntz(row: Row, col: string): IsoDateTime {
  return withOffset(str(row, col));
}

export function ntzOrNull(row: Row, col: string): IsoDateTime | null {
  const v = strOrNull(row, col);
  return v === null ? null : withOffset(v);
}

/** Converts NTZ strings; anything else is returned unchanged (validation reports it). */
function dt(value: unknown): unknown {
  if (typeof value !== 'string' || !NTZ.test(value.trim())) return value;
  return ntzToIsoLocal(value);
}

// ---------------------------------------------------------------------------
// Plan schema (mirrors api/src/types.ts)
// ---------------------------------------------------------------------------

const isoDateTime = z.string().regex(ISO_WITH_OFFSET, 'expected an IsoDateTime with offset');
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');
/** Whole numbers for iOS (Int fields); fractional values are rounded. */
const int = z.number().transform((n) => Math.round(n));
const nullableString = z.string().nullable().default(null);

const ruleId = z.enum(RULE_IDS);

const planItemSchema = z.object({
  item_id: z.string(),
  kind: z.enum(['task', 'fixed_block', 'guard']),
  task_id: nullableString,
  title: z.string(),
  action: z.string(),
  category: z.enum(CATEGORIES).nullable().default(null),
  why: z.string(),
  starts_at: isoDateTime.nullable().default(null),
  ends_at: isoDateTime.nullable().default(null),
  est_minutes: int.nullable().default(null),
  due_at: isoDateTime.nullable().default(null),
  money_at_risk: z.number().nullable().default(null),
  location: nullableString,
  flag: z.enum(['at_risk', 'balance_guard']).nullable().default(null),
  rules_fired: z.array(ruleId),
  evidence: z.array(z.object({ rule: ruleId, label: z.string(), fired: z.boolean(), detail: z.string() })),
  curve: z.array(z.object({ hours: z.number(), cost: z.number() })),
  curve_kind: z.enum(DECAY_CURVES).nullable().default(null),
});

const freeWindowSchema = z.object({
  starts_at: isoDateTime,
  ends_at: isoDateTime,
  minutes: int,
  next_block_title: nullableString,
  next_block_starts_at: isoDateTime.nullable().default(null),
  label: z.string(),
});

const contextSchema = z.object({
  available_minutes: int.nullable().default(null),
  cash_available: z.number().nullable().default(null),
  question: nullableString,
});

const reasoningSchema = z.object({
  summary: z.string(),
  now: isoDateTime,
  free_window: freeWindowSchema.nullable().default(null),
  effective_minutes: int,
  context: contextSchema,
  cash_available: z.number(),
  budget_until: isoDate.nullable().default(null),
  days_until_budget: int.nullable().default(null),
  daily_budget: z.number().nullable().default(null),
  warnings: z.array(z.object({ task_id: nullableString, text: z.string() })),
  balance_guard: z.array(z.string()),
  answer: nullableString,
  pre_rank: z.array(
    z.object({ task_id: z.string(), score: z.number(), rules_fired: z.array(ruleId), first_step_minutes: int, fits: z.boolean() }),
  ),
  trigger: z.enum(['capture', 'rerank', 'seed']),
  previous_plan_id: nullableString,
});

export const planSchema = z.object({
  plan_id: z.string(),
  student_id: z.string(),
  capture_id: nullableString,
  created_at: isoDateTime,
  model: z.string(),
  do_now: planItemSchema.nullable().default(null),
  next: planItemSchema.nullable().default(null),
  today: z.array(planItemSchema),
  can_wait: z.array(planItemSchema),
  reasoning: reasoningSchema,
});

function arr(value: unknown): unknown {
  return value === undefined || value === null ? [] : value;
}

function prepItem(value: unknown): unknown {
  const v = parseVariant(value);
  const o = asRecord(v);
  if (!o) return v;
  return {
    ...o,
    starts_at: dt(o.starts_at),
    ends_at: dt(o.ends_at),
    due_at: dt(o.due_at),
    rules_fired: arr(o.rules_fired),
    evidence: arr(o.evidence),
    curve: arr(o.curve),
  };
}

function prepItems(value: unknown): unknown {
  const v = arr(parseVariant(value));
  return Array.isArray(v) ? v.map((x: unknown) => prepItem(x)) : v;
}

function prepReasoning(value: unknown): unknown {
  const v = parseVariant(value);
  const o = asRecord(v);
  if (!o) return v;
  const fw = asRecord(parseVariant(o.free_window));
  const preRank = arr(o.pre_rank);
  return {
    ...o,
    now: dt(o.now),
    free_window: fw
      ? { ...fw, starts_at: dt(fw.starts_at), ends_at: dt(fw.ends_at), next_block_starts_at: dt(fw.next_block_starts_at) }
      : (o.free_window ?? null),
    context: parseVariant(o.context),
    warnings: arr(o.warnings),
    balance_guard: arr(o.balance_guard),
    pre_rank: Array.isArray(preRank)
      ? preRank.map((p: unknown) => {
          const pr = asRecord(p);
          return pr ? { ...pr, rules_fired: arr(pr.rules_fired) } : p;
        })
      : preRank,
  };
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.map((p) => String(p)).join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
}

/**
 * BUILD_PLAN output (or a PLANS row assembled into the same shape) -> contract Plan.
 * Strips `cortex_errors` (logged at warn), adds the local offset to every NTZ datetime, fills missing arrays
 * with [], validates against the Plan shape and throws on mismatch.
 */
export function normalizePlanFromSnowflake(raw: unknown): Plan {
  const obj = asRecord(parseVariant(raw));
  if (!obj) throw new Error(`invalid plan from Snowflake: expected an object, got ${kindOf(raw)}`);
  const { cortex_errors: cortexErrors, ...rest } = obj;
  if (cortexErrors !== undefined && cortexErrors !== null) {
    const list = Array.isArray(cortexErrors) ? cortexErrors.map((e: unknown) => String(e)) : [String(cortexErrors)];
    if (list.length > 0) log.warn(`BUILD_PLAN cortex_errors (plan wording fell back to sql-prerank): ${list.join(' | ').slice(0, 1000)}`);
  }
  if (rest.error !== undefined && rest.error !== null) {
    throw new Error(`BUILD_PLAN returned error: ${String(rest.error)}`);
  }
  const prepared = {
    ...rest,
    created_at: dt(rest.created_at),
    do_now: rest.do_now === undefined ? null : prepItem(rest.do_now),
    next: rest.next === undefined ? null : prepItem(rest.next),
    today: prepItems(rest.today),
    can_wait: prepItems(rest.can_wait),
    reasoning: prepReasoning(rest.reasoning),
  };
  const result = planSchema.safeParse(prepared);
  if (!result.success) throw new Error(`invalid plan from Snowflake: ${formatIssues(result.error)}`);
  const plan: Plan = result.data;
  return plan;
}

/** `{error}` returned by a procedure, or null. */
export function procedureError(raw: unknown): string | null {
  const o = asRecord(raw);
  if (!o) return raw === null || raw === undefined ? 'procedure returned no value' : null;
  if (o.error === undefined || o.error === null || o.error === '') return null;
  return typeof o.error === 'string' ? o.error : JSON.stringify(o.error);
}

/** RECORD_ACTION output -> Action. */
export function parseAction(raw: unknown): Action {
  const o = asRecord(raw);
  if (!o) throw new Error('RECORD_ACTION returned no object');
  const row: Row = o;
  return {
    action_id: str(row, 'action_id'),
    student_id: str(row, 'student_id'),
    plan_id: str(row, 'plan_id'),
    task_id: strOrNull(row, 'task_id'),
    kind: oneOf(ACTION_KINDS, str(row, 'kind'), 'start_now'),
    created_at: ntz(row, 'created_at'),
  };
}

/** VARIANT PlanContext (V_PLAN_HISTORY.context) -> PlanContext | null. */
export function parseContext(value: unknown): PlanContext | null {
  const o = asRecord(parseVariant(value));
  if (!o) return null;
  const n = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return {
    available_minutes: n(o.available_minutes),
    cash_available: n(o.cash_available),
    question: typeof o.question === 'string' ? o.question : null,
  };
}

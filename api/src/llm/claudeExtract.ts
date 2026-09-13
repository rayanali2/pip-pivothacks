import Anthropic, { APIConnectionTimeoutError, APIUserAbortError } from '@anthropic-ai/sdk';
import { z } from 'zod';
import { CATEGORIES, CONSTRAINT_KINDS, type Task } from '../types';
import { addDays, dateOnly, hhmm, nextIsoDowAfter, parseDateOnly, parseTimeOfDay, toIsoLocal, tryParseIsoLocal, weekdayName } from '../clock';
import { errorMessage } from '../log';
import { defaultEstimateMinutes, type ConstraintDraft, type ExtractResult, type TaskDraft } from '../ranker/extract';
import { capitalize } from '../ranker/text';

// Claude extraction (used before the heuristic parser when ANTHROPIC_API_KEY is set): one Messages API call with a
// JSON-schema output format, then zod validation and the same TaskDraft / ConstraintDraft shapes heuristicExtract returns.
// Any error, timeout or invalid output throws ClaudeExtractError; the caller falls back to heuristicExtract.

/** The fields of a Messages API response this module reads. */
export interface ClaudeMessageLike {
  stop_reason: string | null;
  content: ReadonlyArray<{ type: string; text?: string }>;
}

/** The slice of the Anthropic client used here; tests inject a fake so they never touch the network. */
export interface ClaudeClient {
  messages: {
    create(body: Anthropic.MessageCreateParamsNonStreaming, options?: Anthropic.RequestOptions): PromiseLike<ClaudeMessageLike>;
  };
}

export interface ClaudeExtractOptions {
  client: ClaudeClient;
  /** e.g. 'claude-haiku-4-5' */
  model: string;
  /** whole request budget; no retries */
  timeoutMs: number;
}

export type ClaudeExtractFailure = 'timeout' | 'refusal' | 'invalid_output' | 'api_error';

export class ClaudeExtractError extends Error {
  readonly reason: ClaudeExtractFailure;

  constructor(reason: ClaudeExtractFailure, message: string) {
    super(message);
    this.name = 'ClaudeExtractError';
    this.reason = reason;
  }
}

/** Real client from an API key. No SDK retries: the heuristic parser is the retry. */
export function createClaudeClient(apiKey: string): ClaudeClient {
  return new Anthropic({ apiKey, maxRetries: 0 });
}

// ---------------------------------------------------------------------------
// Prompt and output schema
// ---------------------------------------------------------------------------

const nullable = (schema: { [key: string]: unknown }): { [key: string]: unknown } => ({ anyOf: [schema, { type: 'null' }] });

const TASK_FIELDS = ['merge_into', 'raw_text', 'normalized_text', 'category', 'due_at', 'money_at_risk', 'est_minutes'] as const;
const CONSTRAINT_FIELDS = ['kind', 'minutes', 'amount', 'until', 'title', 'starts_at', 'ends_at', 'location', 'to'] as const;

/** Static so the compiled output grammar is reused across requests. */
export const OUTPUT_SCHEMA: { [key: string]: unknown } = {
  type: 'object',
  additionalProperties: false,
  required: ['tasks', 'constraints', 'question'],
  properties: {
    tasks: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [...TASK_FIELDS],
        properties: {
          merge_into: nullable({ type: 'string' }),
          raw_text: { type: 'string' },
          normalized_text: { type: 'string' },
          category: { type: 'string', enum: [...CATEGORIES] },
          due_at: nullable({ type: 'string' }),
          money_at_risk: nullable({ type: 'number' }),
          est_minutes: nullable({ type: 'integer' }),
        },
      },
    },
    constraints: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [...CONSTRAINT_FIELDS],
        properties: {
          kind: { type: 'string', enum: [...CONSTRAINT_KINDS] },
          minutes: nullable({ type: 'integer' }),
          amount: nullable({ type: 'number' }),
          until: nullable({ type: 'string' }),
          title: nullable({ type: 'string' }),
          starts_at: nullable({ type: 'string' }),
          ends_at: nullable({ type: 'string' }),
          location: nullable({ type: 'string' }),
          to: nullable({ type: 'string' }),
        },
      },
    },
    question: nullable({ type: 'string' }),
  },
};

export const SYSTEM_PROMPT = `You turn a first-year university student's spoken or typed brain dump into structured data for UniMate, a day planner. The student is overloaded; your output decides what UniMate ranks, so extract only what was actually said.

What goes where:
- tasks: things the student has to do (return an item, finish an assignment, buy groceries, pay rent, sleep).
- A class, lecture, lab, tutorial or seminar the student has at a time is a fixed_block constraint, not a task.
- Money the student has to live on ("I have $35 until Friday") is a cash constraint, not a task. Money lost if a task is missed ("or lose the $79 refund") is that task's money_at_risk.
- "I only have 25 minutes" is a time_window constraint. Travel time ("it's 15 minutes to campus") is a travel constraint.
- question: the student's last question, verbatim (e.g. "What should I do?"), or null.

Tasks:
- If a task is the same thing as one of the listed open tasks (same category, same object), set merge_into to that task_id; otherwise null. Never invent task ids.
- normalized_text is a short imperative title ("Return headphones", "Finish CS 101 assignment", "Buy groceries"). raw_text is the clause the student said.
- category: class, assignment (coursework, essays, studying, exams), errand (returns, refunds, groceries, laundry, pharmacy, bank, pick-ups), meal, money (bills, rent, tuition payments), work (shifts), club, social, rest (sleep, naps).
- est_minutes only when the student states how long it takes; otherwise null. For a merged task, est_minutes is null unless the student states a new duration.
- money_at_risk is the dollars lost if the deadline is missed, otherwise null.

Dates and times (use only the reference dates in the message):
- due_at is local time "YYYY-MM-DDTHH:MM" with no offset, or null when no deadline is said.
- A time with no day ("by 5 PM") is today. "tomorrow" is the tomorrow date. A weekday name ("Friday") is the date listed for that weekday, which is always strictly after today.
- A day with no time is 23:59 on that day; "this evening" with no time is 21:00 today; "tonight" with no time is 23:59 today.

Constraint fields (fields that do not apply to the kind are null):
- fixed_block: title (as said, e.g. "Lab" or "CHEM 110 Lab"), starts_at and ends_at as 24h "HH:MM" (ends_at null unless an end time is said), location (null unless said).
- cash: amount in dollars, until as "YYYY-MM-DD" or null.
- time_window: minutes.
- travel: minutes, to (null unless said).`;

function localStamp(date: Date): string {
  return `${dateOnly(date)} ${hhmm(date)}`;
}

/** The user turn: reference clock and dates, open tasks, then the transcript. */
export function buildUserMessage(text: string, now: Date, openTasks: readonly Task[]): string {
  const days: Date[] = [];
  for (let dow = 1; dow <= 7; dow += 1) days.push(nextIsoDowAfter(now, dow));
  days.sort((a, b) => a.getTime() - b.getTime());
  const tomorrow = addDays(now, 1);
  const lines = [
    `Reference clock: it is ${weekdayName(now)} ${localStamp(now)} local time.`,
    `today: ${dateOnly(now)} (${weekdayName(now)})`,
    `tomorrow: ${dateOnly(tomorrow)} (${weekdayName(tomorrow)})`,
    ...days.map((d) => `${weekdayName(d)}: ${dateOnly(d)}`),
    '',
    'Open tasks (task_id | title | category | due | estimate):',
  ];
  if (openTasks.length === 0) lines.push('(none)');
  for (const t of openTasks) {
    const due = t.due_at ? tryParseIsoLocal(t.due_at) : null;
    lines.push(`- ${t.task_id} | ${t.normalized_text} | ${t.category} | ${due ? localStamp(due) : 'no deadline'} | ${t.est_minutes === null ? 'none' : `${t.est_minutes} min`}`);
  }
  lines.push('', '<transcript>', text.trim(), '</transcript>');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const taskOut = z.object({
  merge_into: z.string().nullable(),
  raw_text: z.string(),
  normalized_text: z.string().trim().min(1).max(200),
  category: z.enum(CATEGORIES),
  due_at: z.string().nullable(),
  money_at_risk: z.number().nullable(),
  est_minutes: z.number().int().nullable(),
});

const constraintOut = z.object({
  kind: z.enum(CONSTRAINT_KINDS),
  minutes: z.number().int().nullable(),
  amount: z.number().nullable(),
  until: z.string().nullable(),
  title: z.string().nullable(),
  starts_at: z.string().nullable(),
  ends_at: z.string().nullable(),
  location: z.string().nullable(),
  to: z.string().nullable(),
});

const outputSchema = z.object({
  tasks: z.array(taskOut).max(40),
  constraints: z.array(constraintOut).max(20),
  question: z.string().nullable(),
});

type ConstraintOut = z.infer<typeof constraintOut>;

const DURATION_RE = /\b\d+(?:\.\d+)?\s*(?:min|mins|minutes|hours?|hrs?)\b|\bhalf an hour\b|\ban hour\b/i;

function invalid(message: string): ClaudeExtractError {
  return new ClaudeExtractError('invalid_output', `Claude output invalid: ${message}`);
}

function hhmmOrNull(value: string | null, field: string): string | null {
  if (value === null || value.trim() === '') return null;
  const t = parseTimeOfDay(value);
  if (!t) throw invalid(`${field} is not HH:MM: ${value}`);
  return `${String(t.h).padStart(2, '0')}:${String(t.m).padStart(2, '0')}`;
}

function textOrNull(value: string | null): string | null {
  const t = value === null ? '' : value.trim();
  return t === '' ? null : t;
}

function positiveMinutes(value: number | null, kind: string): number {
  if (value === null || value <= 0 || value > 1440) throw invalid(`${kind} needs minutes between 1 and 1440`);
  return value;
}

/** Exactly the snowflake/NOTES.md "Validated constraint values" shapes. */
function toConstraint(c: ConstraintOut): ConstraintDraft {
  switch (c.kind) {
    case 'fixed_block': {
      const title = textOrNull(c.title);
      const startsAt = hhmmOrNull(c.starts_at, 'fixed_block.starts_at');
      if (title === null || startsAt === null) throw invalid('fixed_block needs title and starts_at');
      return { kind: 'fixed_block', value: { title, starts_at: startsAt, ends_at: hhmmOrNull(c.ends_at, 'fixed_block.ends_at'), location: textOrNull(c.location) } };
    }
    case 'cash': {
      if (c.amount === null || !Number.isFinite(c.amount) || c.amount < 0) throw invalid('cash needs a non-negative amount');
      const until = textOrNull(c.until);
      if (until !== null && parseDateOnly(until) === null) throw invalid(`cash.until is not YYYY-MM-DD: ${until}`);
      return { kind: 'cash', value: { amount: c.amount, until } };
    }
    case 'time_window':
      return { kind: 'time_window', value: { minutes: positiveMinutes(c.minutes, 'time_window') } };
    case 'travel':
      return { kind: 'travel', value: { minutes: positiveMinutes(c.minutes, 'travel'), to: textOrNull(c.to) } };
  }
}

/**
 * Validates Claude's JSON and maps it to ExtractResult: merge_into only for listed open task ids (else null),
 * due_at to IsoDateTime, merged tasks keep their stored estimate unless a duration was said, new tasks get the
 * category default estimate, duplicate drafts dropped.
 */
export function parseClaudeOutput(json: unknown, openTasks: readonly Task[]): ExtractResult {
  const parsed = outputSchema.safeParse(json);
  if (!parsed.success) throw invalid(parsed.error.issues.map((i) => `${i.path.map(String).join('.')}: ${i.message}`).join('; '));
  const out = parsed.data;
  const openIds = new Set(openTasks.map((t) => t.task_id));

  const tasks: TaskDraft[] = [];
  for (const t of out.tasks) {
    const normalized = capitalize(t.normalized_text);
    const rawText = t.raw_text.trim() === '' ? normalized : t.raw_text.trim();
    const mergeInto = t.merge_into !== null && openIds.has(t.merge_into) ? t.merge_into : null;
    let dueAt: string | null = null;
    if (t.due_at !== null && t.due_at.trim() !== '') {
      const due = tryParseIsoLocal(t.due_at);
      if (!due) throw invalid(`due_at is not a local datetime: ${t.due_at}`);
      dueAt = toIsoLocal(due);
    }
    const money = t.money_at_risk !== null && Number.isFinite(t.money_at_risk) && t.money_at_risk > 0 ? t.money_at_risk : null;
    const stated = t.est_minutes !== null && t.est_minutes > 0 ? t.est_minutes : null;
    const est = mergeInto !== null ? (stated !== null && DURATION_RE.test(rawText) ? stated : null) : (stated ?? defaultEstimateMinutes(t.category, rawText));
    const duplicate = tasks.some((d) => (mergeInto !== null && d.merge_into === mergeInto) || (d.category === t.category && d.normalized_text === normalized));
    if (duplicate) continue;
    tasks.push({ merge_into: mergeInto, raw_text: rawText, normalized_text: normalized, category: t.category, due_at: dueAt, money_at_risk: money, est_minutes: est });
  }

  const question = out.question === null || out.question.trim() === '' ? null : out.question.trim();
  return { tasks, constraints: out.constraints.map(toConstraint), question };
}

// ---------------------------------------------------------------------------
// Call
// ---------------------------------------------------------------------------

async function createWithTimeout(options: ClaudeExtractOptions, body: Anthropic.MessageCreateParamsNonStreaming): Promise<ClaudeMessageLike> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new ClaudeExtractError('timeout', `Claude extraction timed out after ${options.timeoutMs} ms`));
    }, options.timeoutMs);
  });
  try {
    const request = Promise.resolve(options.client.messages.create(body, { signal: controller.signal, timeout: options.timeoutMs, maxRetries: 0 }));
    return await Promise.race([request, timeout]);
  } catch (err) {
    if (err instanceof ClaudeExtractError) throw err;
    if (err instanceof APIUserAbortError || err instanceof APIConnectionTimeoutError) {
      throw new ClaudeExtractError('timeout', `Claude extraction timed out after ${options.timeoutMs} ms`);
    }
    throw new ClaudeExtractError('api_error', `Claude request failed: ${errorMessage(err)}`);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Same inputs and output shape as heuristicExtract, via Claude. Throws ClaudeExtractError on any failure. */
export async function claudeExtract(text: string, now: Date, openTasks: readonly Task[], options: ClaudeExtractOptions): Promise<ExtractResult> {
  const message = await createWithTimeout(options, {
    model: options.model,
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: buildUserMessage(text, now, openTasks) }],
    output_config: { format: { type: 'json_schema', schema: OUTPUT_SCHEMA } },
  });
  if (message.stop_reason === 'refusal') throw new ClaudeExtractError('refusal', 'Claude declined the extraction request');
  if (message.stop_reason === 'max_tokens') throw invalid('response was cut off at max_tokens');
  const raw = message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('');
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw invalid('response is not JSON');
  }
  return parseClaudeOutput(json, openTasks);
}

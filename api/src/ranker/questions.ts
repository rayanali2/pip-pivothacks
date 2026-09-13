import type { RuleId, Task } from '../types';
import { formatDay, formatDue, formatTime, formatWhen, tryParseIsoLocal } from '../clock';
import type { MoneyFacts } from './rules';
import { dollars, plural } from './text';

export interface ParsedQuestionContext {
  available_minutes: number | null;
  cash_available: number | null;
}

/** CONTRACT section 3: minutes and cash parsed from a spoken/typed follow-up. */
export function parseContextFromQuestion(question: string | null | undefined): ParsedQuestionContext {
  if (!question) return { available_minutes: null, cash_available: null };
  const q = question.toLowerCase();
  let minutes: number | null = null;
  const min = /(\d+)\s*(min|mins|minutes)\b/.exec(q);
  const hours = /(\d+)\s*hours?\b/.exec(q);
  if (min) minutes = Number(min[1]);
  else if (/half an hour/.test(q)) minutes = 30;
  else if (hours) minutes = Number(hours[1]) * 60;
  else if (/\ban hour\b/.test(q)) minutes = 60;

  const cash = /\$(\d+(\.\d+)?)/.exec(question);
  return {
    available_minutes: minutes !== null && Number.isFinite(minutes) ? minutes : null,
    cash_available: cash ? Number(cash[1]) : null,
  };
}

export type QuestionKind = 'money' | 'why_not' | 'context' | 'other';

const MONEY_RE = /\b(afford|money|budget|cash|spend|spending)\b/i;
const WHY_NOT_RE = /\bwhy\s+(?:not|isn'?t|aren'?t|don'?t i|can'?t i|shouldn'?t i)\s+(?:i\s+)?(?:do\s+|doing\s+)?(?:the\s+|my\s+)?(.+?)[\s?.!]*$/i;

export function questionKind(question: string | null | undefined): QuestionKind {
  if (!question) return 'other';
  if (MONEY_RE.test(question)) return 'money';
  if (WHY_NOT_RE.test(question)) return 'why_not';
  const parsed = parseContextFromQuestion(question);
  if (parsed.available_minutes !== null || parsed.cash_available !== null) return 'context';
  return 'other';
}

export interface AnswerTaskFacts {
  task: Task;
  title: string;
  fired: RuleId[];
  firstStep: number;
  fits: boolean;
}

export interface AnswerFacts {
  now: Date;
  effectiveMinutes: number;
  nextBlock: { title: string; start: Date } | null;
  money: MoneyFacts;
  doNow: AnswerTaskFacts | null;
  previousDoNowTitle: string | null;
  /** all open tasks considered by the plan */
  tasks: AnswerTaskFacts[];
  /** tasks flagged at_risk in this plan */
  atRisk: AnswerTaskFacts[];
}

const STOP = new Set(['the', 'a', 'an', 'my', 'to', 'do', 'for', 'of', 'i', 'it', 'first', 'now', 'go', 'get', 'and', 'on']);

function tokens(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .map((t) => t.replace(/(ies)$/, 'y').replace(/([^s])s$/, '$1'))
      .filter((t) => t.length > 1 && !STOP.has(t)),
  );
}

function bestMatch(query: string, tasks: AnswerTaskFacts[]): AnswerTaskFacts | null {
  const q = tokens(query);
  let best: AnswerTaskFacts | null = null;
  let bestScore = 0;
  for (const t of tasks) {
    const tt = tokens(`${t.title} ${t.task.normalized_text} ${t.task.raw_text}`);
    let shared = 0;
    for (const w of q) if (tt.has(w)) shared += 1;
    const score = shared / Math.max(1, q.size);
    if (score > bestScore) {
      bestScore = score;
      best = t;
    }
  }
  return bestScore > 0 ? best : null;
}

function reasonFor(t: AnswerTaskFacts, facts: AnswerFacts): string {
  const due = t.task.due_at ? tryParseIsoLocal(t.task.due_at) : null;
  const money = t.task.money_at_risk ?? 0;
  if (t.fired.includes('irreversible_loss') && money > 0 && due) return `loses ${dollars(money)} ${formatDue(due, facts.now)}`;
  if ((t.fired.includes('irreversible_loss') || t.fired.includes('fixed_block_collision') || t.fired.includes('academic_deadline')) && due) {
    return `is due ${formatDue(due, facts.now)}`;
  }
  if (t.fired.includes('basic_needs')) return 'is a basic need today';
  return `fits your ${facts.effectiveMinutes} free minutes`;
}

function moneyAnswer(facts: AnswerFacts): string {
  const m = facts.money;
  const parts: string[] = [];
  if (m.budgetUntil && m.daysUntilBudget !== null && m.dailyBudget !== null) {
    parts.push(
      `You have ${dollars(m.cash)} until ${formatDay(m.budgetUntil, facts.now)} (${plural(m.daysUntilBudget, 'day')}), about ${dollars(m.dailyBudget)} a day`,
    );
  } else {
    parts.push(`You have ${dollars(m.cash)} with no set end date`);
  }
  parts.push(`keep groceries under ${dollars(m.groceryCap)}`);
  const risky = facts.tasks.filter((t) => (t.task.money_at_risk ?? 0) > 0);
  const firstRisky = risky[0];
  let tail = '';
  if (firstRisky) {
    const total = risky.reduce((s, t) => s + (t.task.money_at_risk ?? 0), 0);
    const due = firstRisky.task.due_at ? tryParseIsoLocal(firstRisky.task.due_at) : null;
    tail = due
      ? `, and ${dollars(total)} is at stake on "${firstRisky.title}" ${formatDue(due, facts.now)}`
      : `, and ${dollars(total)} is at stake on "${firstRisky.title}"`;
  }
  return `${parts.join('; ')}${tail}.`;
}

function whyNotAnswer(query: string, facts: AnswerFacts): string {
  const match = bestMatch(query, facts.tasks);
  if (!match) return `I couldn't find an open task matching "${query}".`;
  const doNow = facts.doNow;
  if (!doNow) return `"${match.title}" isn't blocked by anything; nothing else fits right now.`;
  if (match.task.task_id === doNow.task.task_id) return `"${match.title}" is already your do now.`;
  const due = match.task.due_at ? tryParseIsoLocal(match.task.due_at) : null;
  const matchParts: string[] = [];
  matchParts.push(due ? `isn't due until ${formatWhen(due, facts.now)}` : 'has no deadline');
  if (!match.fits) matchParts.push(`needs ${match.firstStep} minutes when you have ${facts.effectiveMinutes}`);
  return `"${match.title}" ${matchParts.join(' and ')}, while "${doNow.title}" ${reasonFor(doNow, facts)}, so it comes first.`;
}

function contextAnswer(parsed: ParsedQuestionContext, facts: AnswerFacts): string | null {
  const doNow = facts.doNow;
  const pieces: string[] = [];
  if (parsed.available_minutes !== null) {
    const before = facts.nextBlock ? ` before ${facts.nextBlock.title} at ${formatTime(facts.nextBlock.start)}` : '';
    let s = `With ${facts.effectiveMinutes} minutes${before}, `;
    const risky = facts.atRisk[0];
    if (risky) s += `"${risky.title}" (${risky.firstStep} min) won't fit, so `;
    if (doNow) {
      s += `do now is "${doNow.title}"`;
      if (facts.previousDoNowTitle && facts.previousDoNowTitle !== doNow.title) s += ` instead of "${facts.previousDoNowTitle}"`;
    } else {
      s += 'nothing fits right now';
    }
    pieces.push(s);
  }
  if (parsed.cash_available !== null) {
    const m = facts.money;
    const perDay = m.dailyBudget !== null && m.budgetUntil ? `, about ${dollars(m.dailyBudget)} a day until ${formatDay(m.budgetUntil, facts.now)}` : '';
    pieces.push(`${pieces.length > 0 ? 'with' : 'With'} ${dollars(m.cash)}, keep groceries under ${dollars(m.groceryCap)}${perDay}`);
  }
  if (pieces.length === 0) return null;
  return `${pieces.join('; ')}.`;
}

/** Deterministic answer to context.question (CONTRACT section 3), or null. */
export function answerQuestion(question: string | null, facts: AnswerFacts): string | null {
  if (!question || question.trim() === '') return null;
  const kind = questionKind(question);
  if (kind === 'money') return moneyAnswer(facts);
  if (kind === 'why_not') {
    const m = WHY_NOT_RE.exec(question);
    const query = m?.[1]?.trim() ?? '';
    return query === '' ? null : whyNotAnswer(query, facts);
  }
  return contextAnswer(parseContextFromQuestion(question), facts);
}

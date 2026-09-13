import type { Category, Task } from '../types';
import { formatTime, formatTimeShort } from '../clock';

export function lowerFirst(s: string): string {
  if (s.length === 0) return s;
  const second = s.charAt(1);
  // keep acronyms / course codes ("CS 101 assignment", "RSVP to ...")
  if (second !== '' && second === second.toUpperCase() && second !== second.toLowerCase()) return s;
  return s.charAt(0).toLowerCase() + s.slice(1);
}

export function capitalize(s: string): string {
  return s.length === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1);
}

export function plural(n: number, word: string, pluralWord?: string): string {
  return `${n} ${n === 1 ? word : (pluralWord ?? `${word}s`)}`;
}

export function times(n: number): string {
  if (n === 1) return 'once';
  if (n === 2) return 'twice';
  return `${n} times`;
}

export function dollars(n: number): string {
  const rounded = Math.round(n * 100) / 100;
  return Number.isInteger(rounded) ? `$${rounded}` : `$${rounded.toFixed(2)}`;
}

/** "2:00 to 5:00 PM" or "11:00 AM to 1:00 PM" */
export function formatRange(start: Date, end: Date): string {
  const sameHalf = start.getHours() < 12 === end.getHours() < 12;
  return sameHalf ? `${formatTimeShort(start)} to ${formatTime(end)}` : `${formatTime(start)} to ${formatTime(end)}`;
}

export function joinList(items: string[]): string {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0] ?? '';
  if (items.length === 2) return `${items[0] ?? ''} and ${items[1] ?? ''}`;
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1] ?? ''}`;
}

const LEADING_VERBS = /^(finish|do|buy|get|complete|start|work on|write|submit|return|pick up|drop off|send|call|pay|go to|make|study for|prepare for|prep for)\s+/i;

/** "Finish CS 101 assignment" -> "the CS 101 assignment"; "Do laundry" -> "laundry" */
export function objectPhrase(title: string, withArticle = true): string {
  const stripped = title.replace(LEADING_VERBS, '').trim();
  const base = stripped === '' ? title : stripped;
  const lowered = lowerFirst(base);
  if (!withArticle || /^(the|a|an|my|your)\s/i.test(lowered)) return lowered;
  return `the ${lowered}`;
}

export function mentionsRefund(task: Pick<Task, 'raw_text' | 'normalized_text'>): boolean {
  return /refund/i.test(`${task.raw_text} ${task.normalized_text}`);
}

/** "$79 refund" / "$79" */
export function moneyNoun(task: Pick<Task, 'raw_text' | 'normalized_text' | 'money_at_risk'>): string {
  const m = dollars(task.money_at_risk ?? 0);
  return mentionsRefund(task) ? `${m} refund` : m;
}

const CATEGORY_NOUNS: Record<Category, string> = {
  class: 'a class',
  assignment: 'coursework',
  errand: 'an errand',
  meal: 'a meal',
  money: 'a money task',
  work: 'work',
  club: 'a club task',
  social: 'a social plan',
  rest: 'rest',
};

export function categoryNoun(category: Category): string {
  return CATEGORY_NOUNS[category];
}

/** First clause of a sentence (up to the first , ; or .), without trailing punctuation. */
export function firstClause(sentence: string): string {
  const m = /^[^,;.!?—]+/.exec(sentence.trim());
  const clause = (m ? m[0] : sentence).trim();
  return clause.length > 0 ? clause : sentence.trim();
}

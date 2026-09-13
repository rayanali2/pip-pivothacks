import type { Category, ConstraintKind, IsoDateTime, JsonValue, Task, TimeOfDay } from '../types';
import { addDays, atTime, dateOnly, hhmm, nextFridayAfter, nextIsoDowAfter, startOfDay, toIsoLocal } from '../clock';
import { capitalize } from './text';

export interface TaskDraft {
  /** existing task_id this draft merges into, or null for a new task */
  merge_into: string | null;
  raw_text: string;
  normalized_text: string;
  category: Category;
  due_at: IsoDateTime | null;
  money_at_risk: number | null;
  /** explicit estimate from the text, or a category default for new tasks; null on merges without an explicit estimate */
  est_minutes: number | null;
}

export interface ConstraintDraft {
  kind: ConstraintKind;
  value: JsonValue;
}

export interface ExtractResult {
  tasks: TaskDraft[];
  constraints: ConstraintDraft[];
  /** the last question in the text ("What should I do?"), if any */
  question: string | null;
}

const DEFAULT_EST: Record<Category, number> = {
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

const WEEKDAYS: Record<string, number> = { monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6, sunday: 7 };

const QUESTION_START = /^(what|should|how|why|when|which|where|who|can|could|would|is it|do i|am i)\b/i;
const TASK_START = /^(?:also,?\s+|and\s+|oh,?\s+|so\s+)?(?:i\s+)?(?:really\s+|still\s+|also\s+)?(need|have to|has to|should|must|gotta|got to|want to|'ve got to|remember to|forgot to|keep|am supposed to)\b/i;

// ---------------------------------------------------------------------------
// Sentence / clause splitting
// ---------------------------------------------------------------------------

function normalizeText(text: string): string {
  return text
    .replace(/\b([ap])\.m\./gi, '$1m')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function sentences(text: string): string[] {
  return normalizeText(text)
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function clauses(sentence: string): string[] {
  return sentence
    .replace(/[.!]+$/, '')
    .split(/,?\s+and\s+|;\s*/i)
    .map((c) => c.trim().replace(/^,\s*/, '').replace(/,$/, ''))
    .filter((c) => c.length > 0);
}

// ---------------------------------------------------------------------------
// Times, days, amounts
// ---------------------------------------------------------------------------

interface ParsedTime {
  time: TimeOfDay;
  index: number;
}

function parseTimes(clause: string): ParsedTime[] {
  const out: ParsedTime[] = [];
  const ampm = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/gi;
  for (let m = ampm.exec(clause); m !== null; m = ampm.exec(clause)) {
    let h = Number(m[1]);
    const min = Number(m[2] ?? '0');
    const pm = (m[3] ?? '').toLowerCase() === 'pm';
    if (h < 1 || h > 12 || min > 59) continue;
    if (pm && h !== 12) h += 12;
    if (!pm && h === 12) h = 0;
    out.push({ time: `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`, index: m.index });
  }
  const h24 = /\b([01]?\d|2[0-3]):([0-5]\d)\b(?!\s*(?:am|pm))/gi;
  for (let m = h24.exec(clause); m !== null; m = h24.exec(clause)) {
    out.push({ time: `${String(Number(m[1])).padStart(2, '0')}:${m[2] ?? '00'}`, index: m.index });
  }
  if (/\bnoon\b/i.test(clause)) out.push({ time: '12:00', index: clause.toLowerCase().indexOf('noon') });
  if (/\bmidnight\b/i.test(clause)) out.push({ time: '23:59', index: clause.toLowerCase().indexOf('midnight') });
  return out.sort((a, b) => a.index - b.index);
}

/** Range like "from 2 to 5 PM" / "2-5pm": start and end. */
function parseRange(clause: string): { start: TimeOfDay; end: TimeOfDay } | null {
  const m = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:-|–|to|until|till)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i.exec(clause);
  if (!m) return null;
  const endPm = (m[6] ?? '').toLowerCase() === 'pm';
  const startPm = m[3] ? m[3].toLowerCase() === 'pm' : endPm;
  const conv = (hRaw: string | undefined, minRaw: string | undefined, pm: boolean): TimeOfDay | null => {
    let h = Number(hRaw);
    const min = Number(minRaw ?? '0');
    if (!Number.isFinite(h) || h < 1 || h > 12 || min > 59) return null;
    if (pm && h !== 12) h += 12;
    if (!pm && h === 12) h = 0;
    return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
  };
  const start = conv(m[1], m[2], startPm);
  const end = conv(m[4], m[5], endPm);
  return start && end ? { start, end } : null;
}

/** The day a clause refers to (today, tomorrow, weekday names), or null when none is said. */
function parseDay(clause: string, now: Date): Date | null {
  const c = clause.toLowerCase();
  if (/\b(today|tonight|this evening|this afternoon|end of (the )?day)\b/.test(c)) return startOfDay(now);
  if (/\btomorrow\b/.test(c)) return startOfDay(addDays(now, 1));
  for (const [name, dow] of Object.entries(WEEKDAYS)) {
    if (new RegExp(`\\b${name}\\b`).test(c)) {
      return dow === 5 ? nextFridayAfter(now) : nextIsoDowAfter(now, dow);
    }
  }
  return null;
}

function parseDue(clause: string, now: Date): Date | null {
  const day = parseDay(clause, now);
  const firstTime = parseTimes(clause)[0];
  if (firstTime) {
    if (day) return atTime(day, firstTime.time);
    const today = atTime(now, firstTime.time);
    // a time already past today most likely means tomorrow
    return today.getTime() <= now.getTime() ? atTime(addDays(now, 1), firstTime.time) : today;
  }
  if (day) {
    if (/\bthis evening\b/i.test(clause)) return atTime(day, '21:00');
    return atTime(day, '23:59');
  }
  return null;
}

function parseDollars(clause: string): number | null {
  const m = /\$\s?(\d+(?:\.\d+)?)/.exec(clause) ?? /\b(\d+(?:\.\d+)?)\s*(?:dollars|bucks)\b/i.exec(clause);
  return m ? Number(m[1]) : null;
}

function parseMinutes(clause: string): number | null {
  const c = clause.toLowerCase();
  const min = /(\d+)\s*(?:min|mins|minutes)\b/.exec(c);
  if (min) return Number(min[1]);
  if (/half an hour/.test(c)) return 30;
  const hrs = /(\d+(?:\.\d+)?)\s*(?:hours?|hrs?)\b/.exec(c);
  if (hrs) return Math.round(Number(hrs[1]) * 60);
  if (/\ban hour\b/.test(c)) return 60;
  return null;
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

const CLASS_RE = /\b(lab|lecture|class|tutorial|seminar|recitation|discussion section)\b/i;
const ASSIGNMENT_RE = /\b(assignment|essay|problem set|pset|homework|report|midterm|exam|quiz|paper|project|study|studying|reading)\b/i;
const MONEY_ERRAND_RE = /\b(return|refund|bill|rent|pay|deposit|tuition)\b/i;
const ERRAND_RE = /\b(grocer\w*|laundry|pharmacy|medication|medicine|meds|prescription|pick up|drop off|post office|bank)\b/i;
const MEAL_RE = /\b(lunch|dinner|breakfast|eat|eating|meal|cook)\b/i;
const REST_RE = /\b(sleep|sleeping|nap|bed|rest)\b/i;
const WORK_RE = /\b(shift|work)\b/i;
const CLUB_RE = /\b(club|meeting|rsvp)\b/i;
const SOCIAL_RE = /\b(friend|friends|party|hang out|hangout|call (?:mom|dad|home))\b/i;
const HAVE_RE = /\b(i have|i've got|i got|there's|got a)\b/i;
const COURSE_RE = /\b([A-Z]{2,5})\s?(\d{3}[A-Z]?)\b/;

function classify(clause: string): Category | null {
  if (ASSIGNMENT_RE.test(clause)) return 'assignment';
  if (MONEY_ERRAND_RE.test(clause)) return 'errand';
  if (ERRAND_RE.test(clause)) return 'errand';
  if (MEAL_RE.test(clause)) return 'meal';
  if (REST_RE.test(clause)) return 'rest';
  if (WORK_RE.test(clause)) return 'work';
  if (CLUB_RE.test(clause)) return 'club';
  if (SOCIAL_RE.test(clause)) return 'social';
  if (CLASS_RE.test(clause)) return 'class';
  return null;
}

function courseCode(text: string): string | null {
  const m = COURSE_RE.exec(text);
  return m ? `${m[1] ?? ''} ${m[2] ?? ''}` : null;
}

const TIME_PHRASES = [
  /\b(?:by|at|before|until|till|around|due)\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?\b/gi,
  /\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/gi,
  /\b(?:by|on|this|next)?\s*(?:today|tonight|tomorrow|this evening|this afternoon|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/gi,
  /\b(?:is|are)\s+due\b.*$/gi,
  /\bdue\b.*$/gi,
  /\s+or\s+.*$/gi,
  /\$\s?\d+(?:\.\d+)?/g,
  /\b(?:for|in)\s+\d+\s*(?:min|mins|minutes|hours?|hrs?)\b/gi,
];

function normalizeTitle(clause: string, category: Category): string {
  if (/grocer/i.test(clause)) return 'Buy groceries';
  if (/laundry/i.test(clause)) return 'Do laundry';
  let t = clause.replace(TASK_START, '').replace(/^\s*(?:i\s+)?(?:need|have|want)\s+/i, '');
  t = t.replace(/^\s*to\s+/i, '');
  for (const re of TIME_PHRASES) t = t.replace(re, ' ');
  t = t
    .replace(/\bmy\b\s*/gi, '')
    .replace(/\s+/g, ' ')
    .replace(/[,.!?\s]+$/, '')
    .trim();
  if (t === '') t = category;
  if (category === 'assignment' && !/^(finish|do|write|study|start|submit|work|read|prepare|prep|review)\b/i.test(t)) t = `Finish ${t}`;
  return capitalize(t);
}

// ---------------------------------------------------------------------------
// Merge matching
// ---------------------------------------------------------------------------

const STOPWORDS = new Set(
  (
    'i a an the to my me is are be by or and for of on in at it its this that need needs have has had do does doing get got go going want ' +
    'should must gotta due tomorrow today tonight pm am lose finish buy return make take keep some up from with before until till will just ' +
    'really also still so if can im ive minutes minute min mins hours hour your you we our their them his her call pay pick drop send write ' +
    'submit start clean bring email text book work on off out about lost refund' // "refund" handled via key nouns below
  ).split(' '),
);
const WEEKDAY_WORDS = new Set(Object.keys(WEEKDAYS));

function stem(word: string): string {
  if (word.endsWith('ies') && word.length > 4) return `${word.slice(0, -3)}y`;
  if (/(sh|ch|x|ss)es$/.test(word)) return word.slice(0, -2);
  if (word.endsWith('s') && !word.endsWith('ss') && word.length > 3) return word.slice(0, -1);
  return word;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 0 && !/^\d+$/.test(w))
    .map(stem);
}

function tokenSet(text: string): Set<string> {
  return new Set(tokenize(text).filter((w) => !STOPWORDS.has(w) && !WEEKDAY_WORDS.has(w)));
}

/** Key nouns: content words of length >= 3 (plus "refund", which marks money tasks). */
function keyNouns(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of tokenize(text)) {
    if (w === 'refund') out.add(w);
    else if (w.length >= 3 && !STOPWORDS.has(w) && !WEEKDAY_WORDS.has(w)) out.add(w);
  }
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter += 1;
  return inter / (a.size + b.size - inter);
}

function findMerge(draft: Omit<TaskDraft, 'merge_into'>, openTasks: readonly Task[]): string | null {
  const draftKeys = keyNouns(`${draft.raw_text} ${draft.normalized_text}`);
  const draftTokens = tokenSet(draft.normalized_text);
  const draftCode = courseCode(draft.raw_text);
  let best: { id: string; score: number } | null = null;
  for (const t of openTasks) {
    if (t.category !== draft.category) continue;
    const code = courseCode(`${t.raw_text} ${t.normalized_text}`);
    if (draftCode && code && draftCode !== code) continue;
    const keys = keyNouns(`${t.raw_text} ${t.normalized_text}`);
    let shared = 0;
    for (const k of draftKeys) if (keys.has(k)) shared += 1;
    const j = jaccard(draftTokens, tokenSet(t.normalized_text));
    if (shared === 0 && j < 0.5) continue;
    const score = shared + j;
    if (!best || score > best.score) best = { id: t.task_id, score };
  }
  return best ? best.id : null;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function isQuestion(sentence: string): boolean {
  return /\?\s*$/.test(sentence) || QUESTION_START.test(sentence.trim());
}

function cashUntil(clause: string, now: Date): string | null {
  const day = parseDay(clause, now);
  if (day) return dateOnly(day);
  if (/\bnext week\b/i.test(clause)) return dateOnly(addDays(startOfDay(now), 7));
  if (/\b(end of (the )?week|this week|the week)\b/i.test(clause)) return dateOnly(nextIsoDowAfter(addDays(now, -1), 7));
  return null;
}

/**
 * Heuristic transcript extraction (fallback / mock path). Deterministic.
 * Splits into sentences and " and " clauses, skips questions, turns class-like "I have a 2 PM lab" into
 * fixed_block constraints, "$35 until Friday" into cash, "only have 25 minutes" into time_window,
 * and everything task-like into drafts merged into matching open tasks.
 */
export function heuristicExtract(text: string, now: Date, openTasks: readonly Task[]): ExtractResult {
  const tasks: TaskDraft[] = [];
  const constraints: ConstraintDraft[] = [];
  let question: string | null = null;

  for (const sentence of sentences(text)) {
    if (isQuestion(sentence)) {
      question = sentence;
      continue;
    }
    for (const clause of clauses(sentence)) {
      const lower = clause.toLowerCase();

      // time_window: "I only have 25 minutes"
      if (/\b(?:only\s+)?(?:have|got)\s+(?:about\s+)?(?:\d+\s*(?:min|mins|minutes|hours?)|half an hour|an hour)\b/i.test(lower) && !classify(clause)) {
        const minutes = parseMinutes(clause);
        if (minutes !== null && minutes > 0) {
          constraints.push({ kind: 'time_window', value: { minutes } });
          continue;
        }
      }

      // cash: "I have $35 until Friday"
      const amount = parseDollars(clause);
      if (
        amount !== null &&
        (/\b(until|till|til|to last|left|budget|for the week)\b/i.test(clause) || /\b(i have|i've got|i got|i only have)\s+(?:only\s+)?\$/i.test(clause)) &&
        !MONEY_ERRAND_RE.test(clause)
      ) {
        constraints.push({ kind: 'cash', value: { amount, until: cashUntil(clause, now) } });
        continue;
      }

      // fixed_block: "I have a 2 PM lab"
      const classMatch = CLASS_RE.exec(clause);
      const times = parseTimes(clause);
      const firstTime = times[0];
      if (classMatch && firstTime && HAVE_RE.test(clause) && !ASSIGNMENT_RE.test(clause)) {
        const range = parseRange(clause);
        const keyword = capitalize((classMatch[1] ?? 'class').toLowerCase());
        const code = courseCode(clause);
        constraints.push({
          kind: 'fixed_block',
          value: {
            title: code ? `${code} ${keyword}` : keyword,
            starts_at: range ? range.start : firstTime.time,
            ends_at: range ? range.end : null,
            location: null,
          },
        });
        continue;
      }

      const category = classify(clause);
      if (!category && !TASK_START.test(clause)) continue;
      const cat: Category = category ?? 'errand';

      const due = parseDue(clause, now);
      const dollarsInClause = parseDollars(clause);
      const moneyAtRisk =
        dollarsInClause !== null && (cat === 'errand' || cat === 'money' || /\b(lose|refund|fee|fine|late|charge)\b/i.test(clause))
          ? dollarsInClause
          : null;
      const explicitEst = /\b(?:takes?|need|needs|for|about)\s+(?:about\s+)?(?:\d+\s*(?:min|mins|minutes|hours?|hrs?)|half an hour|an hour)\b/i.test(clause)
        ? parseMinutes(clause)
        : null;

      const draftBase = {
        raw_text: clause,
        normalized_text: normalizeTitle(clause, cat),
        category: cat,
        due_at: due ? toIsoLocal(due) : null,
        money_at_risk: moneyAtRisk,
        est_minutes: explicitEst,
      };
      const existingDraft = tasks.find((t) => t.category === cat && t.normalized_text === draftBase.normalized_text);
      if (existingDraft) continue;
      const mergeInto = findMerge(draftBase, openTasks);
      tasks.push({
        ...draftBase,
        merge_into: mergeInto,
        est_minutes: mergeInto ? explicitEst : (explicitEst ?? (cat === 'rest' && /\bnap\b/i.test(clause) ? 30 : DEFAULT_EST[cat])),
      });
    }
  }

  return { tasks, constraints, question };
}

/** Exposed for the live backend / tests: 'HH:MM' of a Date. */
export function timeOfDay(date: Date): TimeOfDay {
  return hhmm(date);
}

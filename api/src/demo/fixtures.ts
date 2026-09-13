import type { Plan, PlanDiff, PlanItem, Task } from '../types';
import { formatWhen, hhmm, isoDow, parseDateOnly, tryParseIsoLocal, weekdayName, calendarDaysBetween } from '../clock';
import { questionKind, parseContextFromQuestion } from '../ranker/questions';
import { dollars, plural, times } from '../ranker/text';
import { demoBaseline, DEMO_TASK_IDS } from './scenario';

// The spec's "hardcoded correct Today Plan" for the demo (CONTRACT section 5).

export type DemoScenario = 'base' | 'rerank_25';

export interface PlanStructure {
  do_now: string | null;
  next: string | null;
  today: string[];
  can_wait: string[];
}

export const DEMO_LAB_BLOCK = 'block:{dow}:14:00';

export const DEMO_EXPECTED: Readonly<Record<DemoScenario, PlanStructure>> = {
  base: {
    do_now: DEMO_TASK_IDS.return,
    next: DEMO_LAB_BLOCK,
    today: [DEMO_TASK_IDS.assignment, DEMO_TASK_IDS.groceries, DEMO_TASK_IDS.sleep],
    can_wait: [DEMO_TASK_IDS.club, DEMO_TASK_IDS.laundry],
  },
  rerank_25: {
    do_now: DEMO_TASK_IDS.assignment,
    next: DEMO_LAB_BLOCK,
    today: [DEMO_TASK_IDS.return, `${DEMO_TASK_IDS.assignment}#cont`, DEMO_TASK_IDS.groceries, DEMO_TASK_IDS.sleep],
    can_wait: [DEMO_TASK_IDS.club, DEMO_TASK_IDS.laundry],
  },
};

/** Expected slot times (HH:MM start, HH:MM end or null) per today item. */
const EXPECTED_TIMES: Readonly<Record<DemoScenario, Record<string, [string | null, string | null]>>> = {
  base: {
    [DEMO_TASK_IDS.assignment]: ['17:15', '18:45'],
    [DEMO_TASK_IDS.groceries]: ['19:00', '19:40'],
    [DEMO_TASK_IDS.sleep]: ['23:30', null],
  },
  rerank_25: {
    [DEMO_TASK_IDS.return]: [null, null],
    [`${DEMO_TASK_IDS.assignment}#cont`]: ['17:15', '18:45'],
    [DEMO_TASK_IDS.groceries]: ['19:00', '19:40'],
    [DEMO_TASK_IDS.sleep]: ['23:30', null],
  },
};

export function expectedStructure(scenario: DemoScenario, dow: number): PlanStructure {
  const s = DEMO_EXPECTED[scenario];
  return { ...s, next: s.next ? s.next.replace('{dow}', String(dow)) : null, today: [...s.today], can_wait: [...s.can_wait] };
}

export function planStructure(plan: Plan): PlanStructure {
  return {
    do_now: plan.do_now ? plan.do_now.item_id : null,
    next: plan.next ? plan.next.item_id : null,
    today: plan.today.map((i) => i.item_id),
    can_wait: plan.can_wait.map((i) => i.item_id),
  };
}

function sameStructure(a: PlanStructure, b: PlanStructure): boolean {
  return (
    a.do_now === b.do_now &&
    a.next === b.next &&
    a.today.length === b.today.length &&
    a.today.every((x, i) => x === b.today[i]) &&
    a.can_wait.length === b.can_wait.length &&
    a.can_wait.every((x, i) => x === b.can_wait[i])
  );
}

const timeOf = (iso: string | null): string | null => {
  if (!iso) return null;
  const d = tryParseIsoLocal(iso);
  return d ? hhmm(d) : null;
};

function demoTasksIntact(tasks: readonly Task[], now: Date): boolean {
  const baseline = demoBaseline(now).tasks;
  const byId = new Map(tasks.map((t) => [t.task_id, t] as const));
  return baseline.every((b) => {
    const t = byId.get(b.task_id);
    if (!t) return false;
    const sameDue = (t.due_at ? tryParseIsoLocal(t.due_at)?.getTime() : null) === (b.due_at ? tryParseIsoLocal(b.due_at)?.getTime() : null);
    return (
      sameDue &&
      t.category === b.category &&
      t.money_at_risk === b.money_at_risk &&
      t.est_minutes === b.est_minutes &&
      t.normalized_text === b.normalized_text
    );
  });
}

/** Which demo scenario (if any) this plan exactly reproduces. Ignores titles/copy. */
export function detectDemoScenario(plan: Plan, tasks: readonly Task[], now: Date): DemoScenario | null {
  const dow = isoDow(now);
  const structure = planStructure(plan);
  let scenario: DemoScenario | null = null;
  for (const s of ['base', 'rerank_25'] as const) {
    if (sameStructure(structure, expectedStructure(s, dow))) scenario = s;
  }
  if (!scenario) return null;
  const next = plan.next;
  if (!next || next.kind !== 'fixed_block' || next.title !== 'CHEM 110 Lab' || next.location !== 'Science Hall 204') return null;
  if (timeOf(next.starts_at) !== '14:00' || timeOf(next.ends_at) !== '17:00') return null;
  const expectedTimes = EXPECTED_TIMES[scenario];
  for (const item of plan.today) {
    const exp = expectedTimes[item.item_id];
    if (!exp) return null;
    if (timeOf(item.starts_at) !== exp[0] || timeOf(item.ends_at) !== exp[1]) return null;
  }
  const e = plan.reasoning.effective_minutes;
  if (scenario === 'base' && e < 35) return null;
  if (scenario === 'rerank_25' && (e < 20 || e >= 35)) return null;
  if (!demoTasksIntact(tasks, now)) return null;
  return scenario;
}

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

export interface DemoCopyContext {
  /** effective minutes */
  E: number;
  /** minutes left after do now */
  spare: number;
  cash: number;
  cap: number;
  left: number;
  /** "Friday" | "next Friday" | "tomorrow" */
  untilLabel: string;
  days: number;
  perDay: string;
  /** "Friday at 5:00 PM" / "tomorrow at 5:00 PM" / "next Friday at 5:00 PM" */
  clubWhen: string;
  sleepDefers: number;
  sleepHours: number;
}

export interface ItemCopy {
  title: string;
  action: string;
  why: string;
}

type CopyFn = (c: DemoCopyContext) => ItemCopy;

function lastPhrase(c: DemoCopyContext): string {
  return c.days === 1 ? `to get you to ${weekdayWord(c)}` : `for the ${c.days} days until ${c.untilLabel}`;
}

function weekdayWord(c: DemoCopyContext): string {
  return c.untilLabel === 'tomorrow' ? 'Friday tomorrow' : c.untilLabel;
}

const LAB = 'block:lab';

const SHARED: Record<string, CopyFn> = {
  [DEMO_TASK_IDS.groceries]: (c) => ({
    title: 'Groceries',
    action: `Shop for groceries at 7:00 PM with a ${dollars(c.cap)} cap`,
    why: `A ${dollars(c.cap)} cap leaves ${dollars(c.left)} of your ${dollars(c.cash)} ${lastPhrase(c)}, about ${c.perDay} a day.`,
  }),
  [DEMO_TASK_IDS.sleep]: (c) => ({
    title: 'Sleep',
    action: 'Be in bed by 11:30 PM',
    why: `You've pushed sleep back ${times(c.sleepDefers)} in the last ${c.sleepHours} hours, so 11:30 PM is held for a full night before the assignment is due tomorrow.`,
  }),
  [DEMO_TASK_IDS.club]: (c) => ({
    title: 'Outdoors Club RSVP',
    action: `Send the 5-minute RSVP before ${c.clubWhen}`,
    why: `The RSVP isn't due until ${c.clubWhen} and nothing is lost by waiting, so it can wait.`,
  }),
  [DEMO_TASK_IDS.laundry]: () => ({
    title: 'Laundry',
    action: 'Save laundry for a free evening (~90 min)',
    why: "Laundry has no deadline or money riding on it, and its 90 minutes won't fit before Lab, so it can wait.",
  }),
};

export const DEMO_COPY = {
  base: {
    items: {
      ...SHARED,
      [DEMO_TASK_IDS.return]: (c: DemoCopyContext): ItemCopy => ({
        title: 'Return headphones',
        action: 'Grab the headphones and receipt and head to the store now (~35 min)',
        why: `The $79 refund is gone at 5:00 PM and you're in CHEM 110 Lab from 2:00 to 5:00 PM, so the 35-minute return has to happen in the ${c.E} minutes you have now.`,
      }),
      [LAB]: (c: DemoCopyContext): ItemCopy => ({
        title: 'CHEM 110 Lab',
        action: 'Be at Science Hall 204 by 2:00 PM',
        why: `The return leaves you ${plural(c.spare, 'spare minute')} to get to Science Hall 204 before Lab runs from 2:00 to 5:00 PM.`,
      }),
      [DEMO_TASK_IDS.assignment]: (): ItemCopy => ({
        title: 'CS 101 assignment',
        action: 'Work on the CS 101 assignment from 5:15 to 6:45 PM',
        why: "It's due tomorrow at 11:59 PM and needs about 3 hours, so the first 90 minutes go right after Lab.",
      }),
    } as Record<string, CopyFn>,
    summary: (c: DemoCopyContext): string =>
      `You have ${c.E} minutes before CHEM 110 Lab, so return the headphones now and save the $79 refund. Tonight: the assignment at 5:15 PM, groceries under ${dollars(c.cap)} at 7:00 PM, and bed by 11:30 PM.`,
  },
  rerank_25: {
    items: {
      ...SHARED,
      [DEMO_TASK_IDS.assignment]: (c: DemoCopyContext): ItemCopy => ({
        title: 'Outline CS 101 assignment',
        action: 'Open the CS 101 assignment and write a 20-minute outline',
        why: `The 35-minute return won't fit in the ${c.E} minutes before CHEM 110 Lab, so use 20 of them to outline the assignment due tomorrow at 11:59 PM.`,
      }),
      [LAB]: (c: DemoCopyContext): ItemCopy => ({
        title: 'CHEM 110 Lab',
        action: 'Be at Science Hall 204 by 2:00 PM',
        why: `The outline leaves you ${plural(c.spare, 'spare minute')} to get to Science Hall 204 before Lab runs from 2:00 to 5:00 PM.`,
      }),
      [DEMO_TASK_IDS.return]: (c: DemoCopyContext): ItemCopy => ({
        title: 'Return headphones',
        action: `Find ${35 - c.E} more minutes before 2:00 PM or the $79 refund is lost`,
        why: `It needs about 35 minutes but you have ${c.E} before Lab, and returns close at 5:00 PM while you're still in Lab, so the $79 refund is at risk.`,
      }),
      [`${DEMO_TASK_IDS.assignment}#cont`]: (): ItemCopy => ({
        title: 'Finish CS 101 assignment',
        action: 'Pick up from your outline from 5:15 to 6:45 PM',
        why: 'The outline covers 20 of the 180 minutes, so a 90-minute session after Lab keeps the assignment due tomorrow at 11:59 PM on track.',
      }),
    } as Record<string, CopyFn>,
    summary: (c: DemoCopyContext): string =>
      `With only ${c.E} minutes before Lab, outline the assignment now; the $79 headphones return won't fit unless you find ${35 - c.E} more minutes. Tonight: the assignment at 5:15 PM, groceries under ${dollars(c.cap)} at 7:00 PM, and bed by 11:30 PM.`,
    warning: (c: DemoCopyContext): string =>
      `Return headphones needs ~35 min, you have ${c.E} before CHEM 110 Lab, returns close 5:00 PM during Lab — $79 refund at risk unless you find ${35 - c.E} more minutes.`,
    answer: (c: DemoCopyContext): string =>
      `With ${c.E} minutes, the 35-minute return won't fit before CHEM 110 Lab, so do now is the assignment outline and the $79 refund is at risk.`,
  },
  balanceGuard: (c: DemoCopyContext): string =>
    `You've pushed sleep back ${times(c.sleepDefers)} in the last ${c.sleepHours} hours, so bed by 11:30 PM is on today's plan.`,
  diffHeadline: (c: DemoCopyContext): string =>
    `Only ${c.E} min: the 35-min headphones return won't fit before Lab ($79 at risk), so do now is the assignment outline.`,
} as const;

function copyContext(plan: Plan, tasks: readonly Task[], now: Date): DemoCopyContext {
  const r = plan.reasoning;
  const E = r.effective_minutes;
  const doNowFirst = plan.reasoning.pre_rank.find((p) => p.task_id === plan.do_now?.task_id)?.first_step_minutes ?? 0;
  const cash = r.cash_available;
  const cap = Math.floor(cash * 0.6);
  const left = Math.round((cash - cap) * 100) / 100;
  const until = r.budget_until ? parseDateOnly(r.budget_until) : null;
  const days = r.days_until_budget ?? 1;
  const untilLabel = until
    ? (() => {
        const d = calendarDaysBetween(now, until);
        if (d === 1) return 'tomorrow';
        if (d === 7) return `next ${weekdayName(until)}`;
        return weekdayName(until);
      })()
    : 'Friday';
  const club = tasks.find((t) => t.task_id === DEMO_TASK_IDS.club);
  const clubDue = club?.due_at ? tryParseIsoLocal(club.due_at) : null;
  const sleep = tasks.find((t) => t.task_id === DEMO_TASK_IDS.sleep);
  const sleepCreated = sleep ? tryParseIsoLocal(sleep.created_at) : null;
  return {
    E,
    spare: E - doNowFirst,
    cash,
    cap,
    left,
    untilLabel,
    days,
    perDay: dollars(Math.floor((left / Math.max(1, days)) * 100) / 100),
    clubWhen: clubDue ? formatWhen(clubDue, now) : 'Friday at 5:00 PM',
    sleepDefers: sleep?.defer_count ?? 2,
    sleepHours: sleepCreated ? Math.floor((now.getTime() - sleepCreated.getTime()) / 3_600_000) : 40,
  };
}

export interface DemoCopyOptions {
  /** clock.pinned */
  pinned: boolean;
  /** scenario now */
  now: Date;
}

function copyEligible(opts: DemoCopyOptions): boolean {
  return opts.pinned && hhmm(opts.now) === '13:13';
}

/**
 * Mock/fallback polish: when the clock is pinned at 13:13 and the ranker output exactly reproduces a demo scenario,
 * replace ranker template copy with the hand-written copy. Otherwise returns the plan unchanged.
 */
export function applyDemoCopy(plan: Plan, tasks: readonly Task[], opts: DemoCopyOptions): Plan {
  if (!copyEligible(opts)) return plan;
  const scenario = detectDemoScenario(plan, tasks, opts.now);
  if (!scenario) return plan;
  const c = copyContext(plan, tasks, opts.now);
  const copy = DEMO_COPY[scenario];
  const apply = (item: PlanItem): PlanItem => {
    const key = item.kind === 'fixed_block' ? LAB : item.item_id;
    const fn = copy.items[key];
    if (!fn) return item;
    const x = fn(c);
    return { ...item, title: x.title, action: x.action, why: x.why };
  };
  const reasoning = { ...plan.reasoning };
  reasoning.summary = copy.summary(c);
  reasoning.balance_guard = reasoning.balance_guard.length > 0 ? [DEMO_COPY.balanceGuard(c)] : [];
  if (scenario === 'rerank_25') {
    const rr = DEMO_COPY.rerank_25;
    reasoning.warnings = reasoning.warnings.map((w) => (w.task_id === DEMO_TASK_IDS.return ? { ...w, text: rr.warning(c) } : w));
    const q = reasoning.context.question;
    if (q && questionKind(q) === 'context' && parseContextFromQuestion(q).available_minutes !== null) reasoning.answer = rr.answer(c);
  }
  return {
    ...plan,
    do_now: plan.do_now ? apply(plan.do_now) : null,
    next: plan.next ? apply(plan.next) : null,
    today: plan.today.map(apply),
    can_wait: plan.can_wait.map(apply),
    reasoning,
  };
}

/** Demo headline for base -> rerank_25; otherwise the diff unchanged. */
export function applyDemoDiffCopy(diff: PlanDiff, prev: Plan, next: Plan, tasks: readonly Task[], opts: DemoCopyOptions): PlanDiff {
  if (!copyEligible(opts)) return diff;
  if (detectDemoScenario(prev, tasks, opts.now) !== 'base' || detectDemoScenario(next, tasks, opts.now) !== 'rerank_25') return diff;
  const c = copyContext(next, tasks, opts.now);
  const moves = diff.moves.map((m) => {
    const item = [next.do_now, next.next, ...next.today, ...next.can_wait].find((i) => i?.item_id === m.item_id);
    return item ? { ...m, title: item.title } : m;
  });
  return { ...diff, headline: DEMO_COPY.diffHeadline(c), moves };
}

import type {
  Chronotype,
  Constraint,
  DecayConfig,
  IsoDateTime,
  JsonValue,
  Plan,
  PlanContext,
  PlanItem,
  PlanItemFlag,
  PlanTrigger,
  PlanWarning,
  PreRankEntry,
  Profile,
  Task,
  TimeOfDay,
  TimetableBlock,
} from '../types';
import {
  addMinutes,
  atTime,
  formatDay,
  formatDue,
  formatTime,
  formatWhen,
  hhmm,
  isoDow,
  minutesBetween,
  parseDateOnly,
  toIsoLocal,
  tryParseIsoLocal,
} from '../clock';
import { curvePoints, DEFAULT_DECAY_CONFIG } from './decay';
import {
  compareEvals,
  computeMoney,
  evaluateTask,
  GROCERY_SHARE,
  isExpired,
  isGroceries,
  isOpenStatus,
  type CashValue,
  type MoneyFacts,
  type RankContext,
  type TaskEval,
} from './rules';
import { computeFreeWindowsDetailed, readFixedBlockValue, todayBlocks, type FixedBlockValue, type ResolvedBlock } from './windows';
import { answerQuestion, type AnswerTaskFacts } from './questions';
import { capitalize, dollars, formatRange, joinList, lowerFirst, moneyNoun, objectPhrase, plural, times } from './text';

export const RANKER_MODEL = 'deterministic-ranker-v1';

export const BEDTIME: Record<Chronotype, TimeOfDay> = {
  early_bird: '22:30',
  neutral: '23:00',
  night_owl: '23:30',
};

export const SLOT_GAP_MINUTES = 15;
export const MAX_SESSION_MINUTES = 90;

export interface BuildPlanInput {
  plan_id: string;
  student_id: string;
  capture_id: string | null;
  /** real wall-clock record timestamp */
  created_at: IsoDateTime;
  /** scenario clock */
  now: Date;
  /** the student's tasks; only open/deferred, non-expired tasks are ranked */
  tasks: readonly Task[];
  timetable: readonly TimetableBlock[];
  profile: Profile;
  /** constraints from the capture (fixed_block, cash, time_window) */
  constraints: ReadonlyArray<Pick<Constraint, 'kind' | 'value'>>;
  context: PlanContext;
  trigger: PlanTrigger;
  previous_plan?: Plan | null;
  decay?: readonly DecayConfig[];
  model?: string;
}

// ---------------------------------------------------------------------------
// Constraint readers
// ---------------------------------------------------------------------------

function asObject(value: JsonValue): { [key: string]: JsonValue } | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

export function readCashValue(value: JsonValue): CashValue | null {
  const o = asObject(value);
  if (!o) return null;
  const amount = o.amount;
  const until = o.until;
  if (typeof amount !== 'number' || !Number.isFinite(amount)) return null;
  return { amount, until: typeof until === 'string' && parseDateOnly(until) ? until : null };
}

export function readMinutesValue(value: JsonValue): number | null {
  const o = asObject(value);
  if (!o) return null;
  const m = o.minutes;
  return typeof m === 'number' && Number.isFinite(m) && m >= 0 ? Math.floor(m) : null;
}

interface ConstraintFacts {
  fixed: FixedBlockValue[];
  cash: CashValue | null;
  timeWindow: number | null;
}

function readConstraints(constraints: BuildPlanInput['constraints']): ConstraintFacts {
  const fixed: FixedBlockValue[] = [];
  let cash: CashValue | null = null;
  let timeWindow: number | null = null;
  for (const c of constraints) {
    if (c.kind === 'fixed_block') {
      const v = readFixedBlockValue(c.value);
      if (v) fixed.push(v);
    } else if (c.kind === 'cash') {
      const v = readCashValue(c.value);
      if (v) cash = v;
    } else if (c.kind === 'time_window') {
      const v = readMinutesValue(c.value);
      if (v !== null) timeWindow = timeWindow === null ? v : Math.min(timeWindow, v);
    }
  }
  return { fixed, cash, timeWindow };
}

export function expiredTaskIds(tasks: readonly Task[], now: Date): string[] {
  return tasks.filter((t) => isOpenStatus(t) && isExpired(t, now)).map((t) => t.task_id);
}

// ---------------------------------------------------------------------------
// Copy helpers
// ---------------------------------------------------------------------------

const STEP_NOUNS: Record<string, string> = {
  return: 'return',
  pay: 'payment',
  buy: 'shopping trip',
  call: 'call',
  submit: 'submission',
  pick: 'pickup',
  drop: 'drop-off',
  send: 'message',
  email: 'email',
  book: 'booking',
  rsvp: 'RSVP',
};

function stepNoun(ev: TaskEval): string {
  const t = ev.task;
  if (t.category === 'assignment') return ev.totalMinutes > ev.firstStep ? 'outline' : 'finish';
  if (t.category === 'work' || t.category === 'class') return 'start';
  if (isGroceries(t)) return 'shop';
  const first = (t.normalized_text.split(/\s+/)[0] ?? '').toLowerCase();
  return STEP_NOUNS[first] ?? 'task';
}

function titleOf(ev: TaskEval): string {
  return ev.task.normalized_text;
}

interface Env {
  now: Date;
  ctx: RankContext;
  eff: number;
  nb: ResolvedBlock | null;
  money: MoneyFacts;
  doNow: TaskEval | null;
  doNowFits: boolean;
  atRisk: TaskEval[];
  bedtime: Date;
}

function whenOf(ev: TaskEval, env: Env): string {
  return ev.due ? formatWhen(ev.due, env.now) : '';
}

function doNowWhy(ev: TaskEval, env: Env): string {
  const { eff, nb, now } = env;
  const title = titleOf(ev);
  const fs = ev.firstStep;
  const beforeBlock = nb ? ` before ${nb.title}` : '';
  const t = ev.task;
  const money = t.money_at_risk ?? 0;
  if (!env.doNowFits) {
    return eff > 0
      ? `Nothing on your list fits in ${eff} minutes${beforeBlock}, so start ${lowerFirst(title)} now even though it needs ${fs} minutes.`
      : `There's no free time right now, so ${lowerFirst(title)} comes first as soon as you're free, even though it needs ${fs} minutes.`;
  }
  const risky = env.atRisk[0];
  if (risky) {
    return `${capitalize(titleOf(risky))} needs ${risky.firstStep} minutes but you only have ${eff}${beforeBlock}, so spend ${fs} of them on ${objectPhrase(title)}${ev.due ? `, due ${formatDue(ev.due, now)}` : ''}.`;
  }
  if (ev.rules.irreversible_loss && ev.rules.fixed_block_collision && nb && ev.due) {
    const lead = money > 0 ? `The ${moneyNoun(t)} is gone ${formatDue(ev.due, now)}` : `It's due ${formatDue(ev.due, now)}`;
    return `${lead} and you're in ${nb.title} from ${formatRange(nb.start, nb.end)}, so the ${fs}-minute ${stepNoun(ev)} has to happen in the ${eff} minutes you have now.`;
  }
  if (ev.rules.irreversible_loss && ev.due) {
    const lead =
      money > 0 ? `The ${moneyNoun(t)} is gone ${formatDue(ev.due, now)}` : `It's due ${formatDue(ev.due, now)} and a missed deadline can't be undone`;
    return `${lead}, and the ${fs}-minute ${stepNoun(ev)} fits in the ${eff} minutes you have now.`;
  }
  if (ev.rules.fixed_block_collision && nb && ev.due) {
    return `It's due ${formatDue(ev.due, now)}, before ${nb.title} ends at ${formatTime(nb.end)}, so the ${eff} minutes you have now are the last chance.`;
  }
  if (ev.rules.basic_needs) {
    if (isGroceries(t)) {
      return `You need food this week, and a ${fs}-minute shop under ${dollars(env.money.groceryCap)} fits in the ${eff} minutes you have now.`;
    }
    return `It's a basic need today, and the ${fs}-minute ${stepNoun(ev)} fits in the ${eff} minutes you have now.`;
  }
  if (ev.rules.academic_deadline && ev.due) {
    return `It's due ${formatDue(ev.due, now)}, and a ${fs}-minute start fits in the ${eff} minutes you have${beforeBlock}.`;
  }
  return `Nothing more urgent is waiting, and its ${fs} minutes fit in the ${eff} you have${beforeBlock}.`;
}

function doNowAction(ev: TaskEval, env: Env): string {
  const t = ev.task;
  const fs = ev.firstStep;
  const title = titleOf(ev);
  if (t.category === 'assignment') {
    return ev.totalMinutes > fs ? `Open ${objectPhrase(title)} and write a ${fs}-minute outline` : `Finish ${objectPhrase(title)} now (~${fs} min)`;
  }
  if (t.category === 'work' || t.category === 'class') return `Spend the first ${fs} minutes on ${objectPhrase(title)}`;
  if (isGroceries(t)) return `Head to the store now and keep groceries under ${dollars(env.money.groceryCap)} (~${fs} min)`;
  if ((t.money_at_risk ?? 0) > 0) return `Head out now to ${lowerFirst(title)} (~${fs} min)`;
  if (t.category === 'meal') return `Eat something real now (~${fs} min)`;
  return `${title} now (~${fs} min)`;
}

function nextBlockWhy(b: ResolvedBlock, env: Env): string {
  const loc = b.location ?? b.title;
  const range = formatRange(b.start, b.end);
  const d = env.doNow;
  if (!d) return `You have ${env.eff} free minutes before ${b.title} at ${loc} runs from ${range}.`;
  const spare = env.eff - d.firstStep;
  if (spare >= 0) {
    return `The ${d.firstStep}-minute ${stepNoun(d)} leaves you ${plural(spare, 'spare minute')} to get to ${loc} before ${b.title} runs from ${range}.`;
  }
  return `The ${d.firstStep}-minute ${stepNoun(d)} runs ${-spare} minutes past the ${env.eff} you have, so stop in time to reach ${loc} by ${formatTime(b.start)}.`;
}

function nextTaskWhy(ev: TaskEval, env: Env): string {
  const d = env.doNow;
  const left = env.eff - (d ? d.firstStep : 0);
  if (d && left >= ev.firstStep) {
    return `After ${d.firstStep} minutes on ${objectPhrase(titleOf(d))}, its ${ev.firstStep}-minute first step still fits in the ${left} minutes left.`;
  }
  return `It's the next best thing that fits in your ${env.eff} free minutes.`;
}

interface TodayEntry {
  kind: 'task' | 'cont' | 'block';
  ev: TaskEval | null;
  block: ResolvedBlock | null;
  /** 0 at_risk, 1 dated, 2 undated, 3 bedtime */
  group: 0 | 1 | 2 | 3;
  flag: PlanItemFlag | null;
  start: Date | null;
  end: Date | null;
  minutes: number;
  /** remaining minutes to place */
  remaining: number;
  missedSlot: boolean;
}

function guardSentence(ev: TaskEval, env: Env, start: Date | null): string {
  const t = ev.task;
  const h = Math.floor(ev.hoursOpen);
  const at = start ? formatTime(start) : formatTime(env.bedtime);
  if (t.category === 'rest') {
    return t.defer_count >= 2
      ? `You've pushed sleep back ${times(t.defer_count)} in the last ${h} hours, so bed by ${at} is on today's plan.`
      : `Sleep has waited ${h} hours, so bed by ${at} is on today's plan.`;
  }
  return t.defer_count >= 2
    ? `You've put off a proper meal ${times(t.defer_count)}, so ${lowerFirst(titleOf(ev))} is on today's plan at ${at}.`
    : `${capitalize(titleOf(ev))} has waited ${h} hours, so it's on today's plan at ${at}.`;
}

function todayWhy(e: TodayEntry, env: Env): string {
  const { now, eff, nb, money } = env;
  if (e.kind === 'block' && e.block) {
    const b = e.block;
    return `It's on your timetable from ${formatRange(b.start, b.end)}${b.location ? ` in ${b.location}` : ''}.`;
  }
  const ev = e.ev;
  if (!ev) return '';
  const t = ev.task;
  const title = titleOf(ev);
  if (e.flag === 'at_risk') {
    const blockTitle = nb ? nb.title : 'your next block';
    const dueText = ev.due ? formatTime(ev.due) : 'its deadline';
    const risk = (t.money_at_risk ?? 0) > 0 ? `the ${moneyNoun(t)} is at risk` : 'the deadline is at risk';
    return `It needs about ${ev.firstStep} minutes but you only have ${eff} before ${blockTitle}, and it's due at ${dueText} while you're still in ${blockTitle}, so ${risk}.`;
  }
  if (e.kind === 'cont' && env.doNow) {
    const d = env.doNow;
    const rest = d.totalMinutes - d.firstStep;
    const at = e.start ? ` at ${formatTime(e.start)}` : '';
    const due = d.due ? ` before it's due ${formatDue(d.due, now)}` : '';
    return `The first ${d.firstStep} of its ${d.totalMinutes} minutes happen now, so a ${e.minutes}-minute session${at} works through the other ${rest}${due}.`;
  }
  if (e.flag === 'balance_guard') return guardSentence(ev, env, e.start);
  if (t.category === 'rest') return `Sleep keeps tomorrow workable, so bed by ${formatTime(e.start ?? env.bedtime)} is on the plan.`;
  if (e.missedSlot && ev.due) {
    return `It's due ${formatDue(ev.due, now)}, before the next open slot, so it needs a gap you make yourself.`;
  }
  const at = e.start ? formatTime(e.start) : 'later';
  const afterBlock = nb && e.start && e.start.getTime() >= nb.end.getTime() ? ` after ${nb.title}` : '';
  if (isGroceries(t)) {
    const cap = money.groceryCap;
    const left = Math.round((money.cash - cap) * 100) / 100;
    if (money.budgetUntil && money.daysUntilBudget !== null) {
      const days = money.daysUntilBudget;
      const perDay = dollars(Math.floor((left / days) * 100) / 100);
      const untilDay = formatDay(money.budgetUntil, now);
      const span = days === 1 ? `to get you to ${untilDay}` : `for the ${days} days until ${untilDay}`;
      return `A ${dollars(cap)} cap leaves ${dollars(left)} of your ${dollars(money.cash)} ${span}, about ${perDay} a day.`;
    }
    return `A ${dollars(cap)} cap leaves ${dollars(left)} of your ${dollars(money.cash)} for everything else.`;
  }
  if (ev.due && (ev.rules.irreversible_loss || ev.rules.fixed_block_collision || ev.rules.academic_deadline)) {
    const lossLead = (t.money_at_risk ?? 0) > 0 && ev.rules.irreversible_loss ? `The ${moneyNoun(t)} is lost ${formatDue(ev.due, now)}` : `It's due ${formatDue(ev.due, now)}`;
    if (ev.totalMinutes > e.minutes) {
      return `${lossLead} and needs about ${formatHoursWords(ev.totalMinutes)}, so the first ${e.minutes} minutes go at ${at}${afterBlock}.`;
    }
    return `${lossLead}, so its ${e.minutes} minutes are booked at ${at}${afterBlock}.`;
  }
  if (ev.rules.basic_needs && ev.due) {
    return `It's a food or health need due ${formatDue(ev.due, now)}, so ${e.minutes} minutes at ${at}${afterBlock} gets it done in time.`;
  }
  if (ev.rules.basic_needs) return `It's a basic need, so ${e.minutes} minutes at ${at}${afterBlock} keeps today on track.`;
  if (ev.due) return `It's due ${formatDue(ev.due, now)}, so ${e.minutes} minutes at ${at}${afterBlock} keeps it on track.`;
  return `It's booked for ${e.minutes} minutes at ${at}${afterBlock}.`;
}

function formatHoursWords(minutes: number): string {
  if (minutes < 60) return `${minutes} minutes`;
  const h = minutes / 60;
  if (Number.isInteger(h)) return h === 1 ? 'an hour' : `${h} hours`;
  return `${minutes} minutes`;
}

function todayAction(e: TodayEntry, env: Env): string {
  if (e.kind === 'block' && e.block) return `Be at ${e.block.location ?? e.block.title} by ${formatTime(e.block.start)}`;
  const ev = e.ev;
  if (!ev) return '';
  const t = ev.task;
  const title = titleOf(ev);
  const range = e.start && e.end ? formatRange(e.start, e.end) : null;
  if (e.flag === 'at_risk') {
    const short = Math.max(1, ev.firstStep - env.eff);
    const deadline = env.nb ? formatTime(env.nb.start) : ev.due ? formatTime(ev.due) : 'your next block';
    const loss = (t.money_at_risk ?? 0) > 0 ? `the ${moneyNoun(t)} is lost` : 'the deadline passes';
    return `Find ${short} more minutes before ${deadline} or ${loss}`;
  }
  if (e.kind === 'cont') return range ? `Pick up where you left off from ${range}` : `Pick up where you left off (~${e.minutes} min)`;
  if (t.category === 'rest') return `Be in bed by ${formatTime(e.start ?? env.bedtime)}`;
  if (isGroceries(t)) {
    return e.start ? `Shop for groceries at ${formatTime(e.start)} with a ${dollars(env.money.groceryCap)} cap` : `Shop for groceries with a ${dollars(env.money.groceryCap)} cap`;
  }
  if (t.category === 'assignment' || t.category === 'work' || t.category === 'class') {
    return range ? `Work on ${objectPhrase(title)} from ${range}` : `Work on ${objectPhrase(title)} (~${e.minutes} min)`;
  }
  return e.start ? `${title} at ${formatTime(e.start)} (~${e.minutes} min)` : `${title} (~${e.minutes} min)`;
}

function canWaitWhy(ev: TaskEval, env: Env): string {
  const t = ev.task;
  const hoursToDue = ev.due ? minutesBetween(env.now, ev.due) / 60 : null;
  const duePart = !ev.due
    ? 'No deadline'
    : hoursToDue !== null && hoursToDue > 48
      ? `Not due until ${whenOf(ev, env)}`
      : `Due ${formatDue(ev.due, env.now)}, but nothing is lost for good`;
  const money = t.money_at_risk ?? 0;
  const moneyPart = money > 0 ? `${dollars(money)} only matters later` : 'no money at risk';
  const fitPart = ev.fits ? '' : `, and at ${ev.firstStep} minutes it won't fit the ${env.eff} free now`;
  const deferPart = t.defer_count > 0 ? ` (pushed back ${times(t.defer_count)} so far)` : '';
  return `${duePart} and ${moneyPart}${fitPart}, so it can wait${deferPart}.`;
}

function canWaitAction(ev: TaskEval, env: Env): string {
  const title = titleOf(ev);
  const est = ev.task.est_minutes ?? ev.firstStep;
  if (ev.due) return `${title} before ${whenOf(ev, env)} (~${est} min)`;
  return `${title} on a free evening (~${est} min)`;
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

function taskItem(ev: TaskEval, env: Env, decay: readonly DecayConfig[], fields: Partial<PlanItem>): PlanItem {
  const t = ev.task;
  return {
    item_id: t.task_id,
    kind: 'task',
    task_id: t.task_id,
    title: titleOf(ev),
    action: '',
    category: t.category,
    why: '',
    starts_at: null,
    ends_at: null,
    est_minutes: t.est_minutes,
    due_at: t.due_at,
    money_at_risk: t.money_at_risk,
    location: null,
    flag: null,
    rules_fired: [...ev.fired],
    evidence: ev.evidence.map((x) => ({ ...x })),
    curve: curvePoints(t, env.now, decay),
    curve_kind: ev.curveKind,
    ...fields,
  };
}

function blockItem(b: ResolvedBlock, why: string, action: string): PlanItem {
  return {
    item_id: `block:${b.day_of_week}:${b.starts_at}`,
    kind: 'fixed_block',
    task_id: null,
    title: b.title,
    action,
    category: 'class',
    why,
    starts_at: toIsoLocal(b.start),
    ends_at: toIsoLocal(b.end),
    est_minutes: Math.round(minutesBetween(b.start, b.end)),
    due_at: null,
    money_at_risk: null,
    location: b.location,
    flag: null,
    rules_fired: [],
    evidence: [],
    curve: [],
    curve_kind: null,
  };
}

function answerFacts(ev: TaskEval): AnswerTaskFacts {
  return { task: ev.task, title: titleOf(ev), fired: ev.fired, firstStep: ev.firstStep, fits: ev.fits };
}

// ---------------------------------------------------------------------------
// buildPlan
// ---------------------------------------------------------------------------

/** CONTRACT section 4. Pure and deterministic: ids, created_at and now are inputs. */
export function buildPlan(input: BuildPlanInput): Plan {
  const now = input.now;
  const decay = input.decay ?? DEFAULT_DECAY_CONFIG;
  const cf = readConstraints(input.constraints);

  // free window
  const blocks = todayBlocks(input.timetable, cf.fixed, now);
  const windows = computeFreeWindowsDetailed(blocks, now);
  const first = windows[0] ?? null;
  const freeMinutes = first ? first.window.minutes : 0;
  const nb = first ? first.next : null;
  const windowStart = first ? (tryParseIsoLocal(first.window.starts_at) ?? now) : now;
  const limits = [input.context.available_minutes, cf.timeWindow].filter((x): x is number => x !== null && Number.isFinite(x));
  const effective = Math.max(0, Math.floor(Math.min(freeMinutes, ...limits)));

  const money = computeMoney(input.profile, cf.cash, input.context.cash_available, now);
  const ctx: RankContext = { now, nextBlock: nb, freeWindow: first ? first.window : null, freeMinutes, effectiveMinutes: effective, money };

  // rank
  const open = input.tasks.filter((t) => isOpenStatus(t));
  const expired = open.filter((t) => isExpired(t, now));
  const evals = open
    .filter((t) => !isExpired(t, now))
    .map((t) => evaluateTask(t, ctx, decay))
    .sort(compareEvals);

  let doNow = evals.find((e) => e.fits && e.task.category !== 'rest') ?? null;
  let doNowFits = true;
  if (!doNow) {
    doNow = evals.find((e) => e.task.category !== 'rest') ?? null;
    doNowFits = false;
  }
  const nextTask = nb ? null : (evals.find((e) => e !== doNow && e.fits && e.task.category !== 'rest') ?? null);

  const used = new Set<TaskEval>();
  if (doNow) used.add(doNow);
  if (nextTask) used.add(nextTask);

  const atRisk = evals.filter((e) => !used.has(e) && e.rules.irreversible_loss && e.rules.fixed_block_collision && !e.fits);
  const todayEvals = evals.filter(
    (e) =>
      !used.has(e) &&
      (e.rules.irreversible_loss || e.rules.fixed_block_collision || e.rules.basic_needs || e.rules.academic_deadline || e.guard),
  );
  const todaySet = new Set(todayEvals);
  const canWait = evals.filter((e) => !used.has(e) && !todaySet.has(e));

  const bedtime = atTime(now, BEDTIME[input.profile.chronotype]);
  const env: Env = { now, ctx, eff: effective, nb, money, doNow, doNowFits, atRisk, bedtime };

  // today entries
  const entries: TodayEntry[] = [];
  const atRiskSet = new Set(atRisk);
  for (const e of todayEvals) {
    const isRisk = atRiskSet.has(e);
    const group: TodayEntry['group'] = isRisk ? 0 : e.task.category === 'rest' ? 3 : e.due ? 1 : 2;
    const flag: PlanItemFlag | null = isRisk ? 'at_risk' : e.guard ? 'balance_guard' : null;
    entries.push({ kind: 'task', ev: e, block: null, group, flag, start: null, end: null, minutes: 0, remaining: e.totalMinutes, missedSlot: false });
  }
  if (doNow && (doNow.task.category === 'assignment' || doNow.task.category === 'work') && doNow.totalMinutes > doNow.firstStep) {
    entries.push({
      kind: 'cont',
      ev: doNow,
      block: null,
      group: doNow.due ? 1 : 2,
      flag: null,
      start: null,
      end: null,
      minutes: 0,
      remaining: doNow.totalMinutes - doNow.firstStep,
      missedSlot: false,
    });
  }
  entries.sort((a, b) => {
    if (a.group !== b.group) return a.group - b.group;
    const ea = a.ev;
    const eb = b.ev;
    if (!ea || !eb) return 0;
    if (a.group === 1) {
      const da = ea.due ? ea.due.getTime() : 0;
      const db = eb.due ? eb.due.getTime() : 0;
      if (da !== db) return da - db;
    }
    if (a.group === 3 && a.flag !== b.flag) return a.flag === 'balance_guard' ? -1 : 1;
    return compareEvals(ea, eb);
  });

  // slotting
  const warnings: PlanWarning[] = [];
  const later = nb ? blocks.filter((b) => b.start.getTime() >= nb.end.getTime()) : [];
  let cursor: Date;
  if (nb) cursor = addMinutes(nb.end, SLOT_GAP_MINUTES);
  else {
    const base = new Date(Math.max(windowStart.getTime(), now.getTime()));
    const doNowMinutes = (doNow ? doNow.firstStep : 0) + (nextTask ? SLOT_GAP_MINUTES + nextTask.firstStep : 0);
    cursor = addMinutes(base, doNowMinutes + SLOT_GAP_MINUTES);
  }
  for (const e of entries) {
    if (!e.ev) continue;
    if (e.group === 0) {
      e.minutes = e.ev.firstStep;
      continue;
    }
    if (e.group === 3) {
      e.start = bedtime;
      e.end = null;
      e.minutes = e.remaining;
      continue;
    }
    const session = Math.max(1, Math.min(e.remaining, MAX_SESSION_MINUTES));
    let start = cursor;
    for (const b of later) {
      if (start.getTime() < b.end.getTime() && addMinutes(start, session).getTime() > b.start.getTime()) {
        start = addMinutes(b.end, SLOT_GAP_MINUTES);
      }
    }
    e.minutes = session;
    const due = e.ev.due;
    if (e.kind === 'task' && due && start.getTime() >= due.getTime()) {
      e.missedSlot = true;
      warnings.push({
        task_id: e.ev.task.task_id,
        text: `${capitalize(titleOf(e.ev))} is due ${formatDue(due, now)}, before your next open slot at ${formatTime(start)}.`,
      });
      continue;
    }
    e.start = start;
    e.end = addMinutes(start, session);
    cursor = addMinutes(e.end, SLOT_GAP_MINUTES);
  }

  // fixed blocks after the next block, placed at their times
  const finalEntries: TodayEntry[] = [...entries];
  for (const b of later) {
    const blockEntry: TodayEntry = { kind: 'block', ev: null, block: b, group: 1, flag: null, start: b.start, end: b.end, minutes: 0, remaining: 0, missedSlot: false };
    let idx = finalEntries.findIndex((x) => x.group === 3 || (x.group !== 0 && x.start !== null && x.start.getTime() > b.start.getTime()));
    if (idx < 0) idx = finalEntries.length;
    finalEntries.splice(idx, 0, blockEntry);
  }

  // items
  const doNowItem: PlanItem | null = doNow
    ? taskItem(doNow, env, decay, {
        action: doNowAction(doNow, env),
        why: doNowWhy(doNow, env),
        starts_at: toIsoLocal(new Date(Math.max(windowStart.getTime(), now.getTime()))),
        ends_at: toIsoLocal(addMinutes(new Date(Math.max(windowStart.getTime(), now.getTime())), doNow.firstStep)),
      })
    : null;

  let nextItem: PlanItem | null = null;
  if (nb) nextItem = blockItem(nb, nextBlockWhy(nb, env), `Be at ${nb.location ?? nb.title} by ${formatTime(nb.start)}`);
  else if (nextTask) {
    nextItem = taskItem(nextTask, env, decay, {
      action: `Then ${lowerFirst(titleOf(nextTask))} (~${nextTask.firstStep} min)`,
      why: nextTaskWhy(nextTask, env),
    });
  }

  const todayItems: PlanItem[] = finalEntries.map((e) => {
    if (e.kind === 'block' && e.block) return blockItem(e.block, todayWhy(e, env), todayAction(e, env));
    const ev = e.ev;
    if (!ev) throw new Error('today entry without task');
    const base: Partial<PlanItem> = {
      action: todayAction(e, env),
      why: todayWhy(e, env),
      starts_at: e.start ? toIsoLocal(e.start) : null,
      ends_at: e.end ? toIsoLocal(e.end) : null,
      flag: e.flag,
    };
    if (e.kind === 'cont') {
      return taskItem(ev, env, decay, {
        ...base,
        item_id: `${ev.task.task_id}#cont`,
        title: `${titleOf(ev)} (continued)`,
        est_minutes: e.remaining,
        flag: null,
      });
    }
    return taskItem(ev, env, decay, base);
  });

  const canWaitItems: PlanItem[] = canWait.map((ev) => taskItem(ev, env, decay, { action: canWaitAction(ev, env), why: canWaitWhy(ev, env) }));

  // warnings
  for (const r of atRisk) {
    const t = r.task;
    const blockTitle = nb ? nb.title : 'your next block';
    const due = r.due ? formatTime(r.due) : 'its deadline';
    const stake = (t.money_at_risk ?? 0) > 0 ? `${moneyNoun(t)} at risk` : 'deadline at risk';
    warnings.unshift({
      task_id: t.task_id,
      text: `${capitalize(titleOf(r))} needs ~${r.firstStep} min, you have ${effective} before ${blockTitle}, due ${due} during ${nb ? nb.title : 'it'} — ${stake} unless you find ${Math.max(1, r.firstStep - effective)} more minutes.`,
    });
  }
  if (doNow && !doNowFits) {
    warnings.push({
      task_id: doNow.task.task_id,
      text: `Nothing fits in ${effective} minutes; ${lowerFirst(titleOf(doNow))} needs ${doNow.firstStep}.`,
    });
  }
  for (const t of expired) {
    const due = t.due_at ? tryParseIsoLocal(t.due_at) : null;
    warnings.push({
      task_id: t.task_id,
      text: `${capitalize(t.normalized_text)} passed its deadline${due ? ` ${formatDue(due, now)}` : ''} and is marked expired.`,
    });
  }

  const balanceGuard: string[] = finalEntries
    .filter((e) => e.flag === 'balance_guard' && e.ev)
    .map((e) => (e.ev ? guardSentence(e.ev, env, e.start) : ''));

  // answer
  const answer = answerQuestion(input.context.question, {
    now,
    effectiveMinutes: effective,
    nextBlock: nb ? { title: nb.title, start: nb.start } : null,
    money,
    doNow: doNow ? answerFacts(doNow) : null,
    previousDoNowTitle: input.previous_plan?.do_now?.title ?? null,
    tasks: evals.map(answerFacts),
    atRisk: atRisk.map(answerFacts),
  });

  // summary
  let s1: string;
  if (doNow) {
    const where = nb ? `you have ${effective} minutes before ${nb.title} at ${formatTime(nb.start)}` : `you have ${effective} free minutes`;
    s1 = `Start with ${lowerFirst(titleOf(doNow))}: ${where}`;
    const risky = atRisk[0];
    if (risky) s1 += `, and ${objectPhrase(titleOf(risky))} won't fit unless you find ${Math.max(1, risky.firstStep - effective)} more minutes`;
    s1 += '.';
  } else {
    s1 = 'Nothing on your list needs doing right now.';
  }
  const laterBits = todayItems
    .filter((i) => i.kind === 'task' && i.starts_at !== null)
    .slice(0, 3)
    .map((i) => {
      const s = i.starts_at ? tryParseIsoLocal(i.starts_at) : null;
      return `${lowerFirst(i.title)}${s ? ` at ${formatTime(s)}` : ''}`;
    });
  const summary = laterBits.length > 0 ? `${s1} Later: ${joinList(laterBits)}.` : s1;

  const preRank: PreRankEntry[] = evals.map((e) => ({
    task_id: e.task.task_id,
    score: e.score,
    rules_fired: [...e.fired],
    first_step_minutes: e.firstStep,
    fits: e.fits,
  }));

  return {
    plan_id: input.plan_id,
    student_id: input.student_id,
    capture_id: input.capture_id,
    created_at: input.created_at,
    model: input.model ?? RANKER_MODEL,
    do_now: doNowItem,
    next: nextItem,
    today: todayItems,
    can_wait: canWaitItems,
    reasoning: {
      summary,
      now: toIsoLocal(now),
      free_window: first ? first.window : null,
      effective_minutes: effective,
      context: { ...input.context },
      cash_available: money.cash,
      budget_until: money.budgetUntilIso,
      days_until_budget: money.daysUntilBudget,
      daily_budget: money.dailyBudget,
      warnings,
      balance_guard: balanceGuard,
      answer,
      pre_rank: preRank,
      trigger: input.trigger,
      previous_plan_id: input.previous_plan ? input.previous_plan.plan_id : null,
    },
  };
}

// ---------------------------------------------------------------------------
// hydratePlan (for Snowflake BUILD_PLAN output)
// ---------------------------------------------------------------------------

function blockFromItem(item: PlanItem, now: Date): ResolvedBlock | null {
  if (item.kind !== 'fixed_block' || !item.starts_at || !item.ends_at) return null;
  const start = tryParseIsoLocal(item.starts_at);
  const end = tryParseIsoLocal(item.ends_at);
  if (!start || !end) return null;
  const dowMatch = /^block:(\d):/.exec(item.item_id);
  return {
    title: item.title,
    location: item.location,
    day_of_week: dowMatch ? Number(dowMatch[1]) : isoDow(now),
    starts_at: hhmm(start),
    ends_at: hhmm(end),
    start,
    end,
  };
}

/** Rebuilds the rule context a plan was computed with (from its own reasoning and next block). */
export function rankContextFromPlan(plan: Plan, now: Date): RankContext {
  const r = plan.reasoning;
  let nextBlock: ResolvedBlock | null = plan.next ? blockFromItem(plan.next, now) : null;
  if (!nextBlock && r.free_window?.next_block_starts_at) {
    const startIso = r.free_window.next_block_starts_at;
    const fromToday = plan.today.find((i) => i.kind === 'fixed_block' && i.starts_at === startIso);
    nextBlock = fromToday ? blockFromItem(fromToday, now) : null;
    if (!nextBlock) {
      const start = tryParseIsoLocal(startIso);
      if (start) {
        const end = addMinutes(start, 60);
        nextBlock = {
          title: r.free_window.next_block_title ?? 'Class',
          location: null,
          day_of_week: isoDow(start),
          starts_at: hhmm(start),
          ends_at: hhmm(end),
          start,
          end,
        };
      }
    }
  }
  const budgetUntil = r.budget_until ? parseDateOnly(r.budget_until) : null;
  const money: MoneyFacts = {
    cash: r.cash_available,
    budgetUntil,
    budgetUntilIso: r.budget_until,
    daysUntilBudget: r.days_until_budget,
    dailyBudget: r.daily_budget,
    groceryCap: Math.floor(r.cash_available * GROCERY_SHARE),
  };
  return {
    now,
    nextBlock,
    freeWindow: r.free_window,
    freeMinutes: r.free_window ? r.free_window.minutes : 0,
    effectiveMinutes: r.effective_minutes,
    money,
  };
}

/**
 * (Re)fills evidence, curve and curve_kind for every task item (and rules_fired when empty).
 * The live backend runs this on Snowflake BUILD_PLAN output, which may leave evidence/curve empty.
 */
export function hydratePlan(plan: Plan, tasks: readonly Task[], decay: readonly DecayConfig[], now: Date): Plan {
  const ctx = rankContextFromPlan(plan, now);
  const byId = new Map(tasks.map((t) => [t.task_id, t] as const));
  const fill = (item: PlanItem): PlanItem => {
    if (item.kind === 'fixed_block') return { ...item, evidence: [], curve: [], curve_kind: null };
    const id = item.task_id ?? item.item_id.replace(/#cont$/, '');
    const task = byId.get(id);
    if (!task) return item;
    const ev = evaluateTask(task, ctx, decay);
    return {
      ...item,
      task_id: item.task_id ?? task.task_id,
      rules_fired: item.rules_fired.length > 0 ? item.rules_fired : [...ev.fired],
      evidence: ev.evidence,
      curve: curvePoints(task, now, decay),
      curve_kind: ev.curveKind,
    };
  };
  return {
    ...plan,
    do_now: plan.do_now ? fill(plan.do_now) : null,
    next: plan.next ? fill(plan.next) : null,
    today: plan.today.map(fill),
    can_wait: plan.can_wait.map(fill),
  };
}

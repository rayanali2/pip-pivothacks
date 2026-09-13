import type {
  Category,
  DecayConfig,
  DecayCurve,
  FreeWindow,
  IsoDate,
  Profile,
  RuleEvidence,
  RuleId,
  Task,
} from '../types';
import { RULE_IDS } from '../types';
import {
  addHours,
  calendarDaysBetween,
  dateOnly,
  formatDay,
  formatDuration,
  formatTime,
  formatDue,
  formatWhen,
  hoursBetween,
  minutesBetween,
  parseDateOnly,
  tryParseIsoLocal,
} from '../clock';
import { cost, curveKindFor, DEFAULT_DECAY_CONFIG } from './decay';
import type { ResolvedBlock } from './windows';
import { categoryNoun, dollars, formatRange, mentionsRefund, plural, times } from './text';

export const RULE_LABELS: Record<RuleId, string> = {
  irreversible_loss: 'Irreversible deadline or money loss',
  fixed_block_collision: 'Collides with a fixed class/lab block',
  basic_needs: 'Affects basic needs today',
  fits_window: 'First step fits the free window',
  academic_deadline: 'Near academic deadline',
};

export const RULE_WEIGHTS: Record<RuleId, number> = {
  irreversible_loss: 10_000,
  fixed_block_collision: 1_000,
  basic_needs: 100,
  fits_window: 10,
  academic_deadline: 1,
};

export const ACADEMIC_CATEGORIES: readonly Category[] = ['assignment', 'class', 'work'];
const HARD_DEADLINE_CATEGORIES: readonly Category[] = ['assignment', 'work', 'money'];
export const BASIC_NEEDS_RE = /grocer|medic|pharm|prescription|sleep|lunch|dinner|breakfast|meal/i;
export const GROCERY_RE = /grocer/i;

export const GROCERY_SHARE = 0.6;

export interface MoneyFacts {
  cash: number;
  budgetUntil: Date | null;
  budgetUntilIso: IsoDate | null;
  daysUntilBudget: number | null;
  dailyBudget: number | null;
  groceryCap: number;
}

export interface CashValue {
  amount: number;
  until: IsoDate | null;
}

/** CONTRACT section 4, money. Precedence for cash: context > cash constraint > profile. */
export function computeMoney(
  profile: Pick<Profile, 'cash_available' | 'budget_until'>,
  cashConstraint: CashValue | null,
  contextCash: number | null,
  now: Date,
): MoneyFacts {
  const cash = contextCash ?? cashConstraint?.amount ?? profile.cash_available;
  const untilIso = cashConstraint?.until ?? profile.budget_until;
  const budgetUntil = untilIso ? parseDateOnly(untilIso) : null;
  const daysUntilBudget = budgetUntil ? Math.max(1, calendarDaysBetween(now, budgetUntil)) : null;
  const dailyBudget = daysUntilBudget ? Math.round((cash / daysUntilBudget) * 100) / 100 : null;
  return {
    cash,
    budgetUntil,
    budgetUntilIso: budgetUntil ? dateOnly(budgetUntil) : null,
    daysUntilBudget,
    dailyBudget,
    groceryCap: Math.floor(cash * GROCERY_SHARE),
  };
}

export interface RankContext {
  now: Date;
  /** block that ends the current free window (starts after now), or null */
  nextBlock: ResolvedBlock | null;
  freeWindow: FreeWindow | null;
  freeMinutes: number;
  /** min(free minutes, context.available_minutes, time_window) */
  effectiveMinutes: number;
  money: MoneyFacts;
}

export interface TaskEval {
  task: Task;
  due: Date | null;
  firstStep: number;
  /** est_minutes or the category default */
  totalMinutes: number;
  rules: Record<RuleId, boolean>;
  fired: RuleId[];
  fits: boolean;
  guard: boolean;
  hoursOpen: number;
  tiebreak: number;
  score: number;
  curveKind: DecayCurve;
  evidence: RuleEvidence[];
}

export function isAcademic(category: Category): boolean {
  return ACADEMIC_CATEGORIES.includes(category);
}

export function firstStepMinutes(task: Pick<Task, 'category' | 'est_minutes'>): number {
  if (isAcademic(task.category)) return Math.min(task.est_minutes ?? 60, 20);
  return task.est_minutes ?? 15;
}

export function totalMinutes(task: Pick<Task, 'category' | 'est_minutes'>): number {
  return task.est_minutes ?? (isAcademic(task.category) ? 60 : 15);
}

export function isBasicNeeds(task: Pick<Task, 'category' | 'raw_text' | 'normalized_text'>): boolean {
  return task.category === 'meal' || task.category === 'rest' || BASIC_NEEDS_RE.test(task.normalized_text) || BASIC_NEEDS_RE.test(task.raw_text);
}

export function isGroceries(task: Pick<Task, 'raw_text' | 'normalized_text'>): boolean {
  return GROCERY_RE.test(task.normalized_text) || GROCERY_RE.test(task.raw_text);
}

export function isOpenStatus(task: Pick<Task, 'status'>): boolean {
  return task.status === 'open' || task.status === 'deferred';
}

export function isExpired(task: Pick<Task, 'due_at'>, now: Date): boolean {
  if (!task.due_at) return false;
  const due = tryParseIsoLocal(task.due_at);
  return due !== null && due.getTime() <= now.getTime();
}

/** 36h balance guard. */
export function balanceGuardFires(task: Pick<Task, 'category' | 'created_at' | 'defer_count'>, now: Date): boolean {
  if (task.category !== 'meal' && task.category !== 'rest') return false;
  const created = tryParseIsoLocal(task.created_at);
  const hoursOpen = created ? hoursBetween(created, now) : 0;
  return hoursOpen >= 36 || task.defer_count >= 2;
}

const round4 = (n: number): number => Math.round(n * 10_000) / 10_000;

export function evaluateTask(task: Task, ctx: RankContext, decay: readonly DecayConfig[] = DEFAULT_DECAY_CONFIG): TaskEval {
  const { now, nextBlock, effectiveMinutes } = ctx;
  const due = task.due_at ? tryParseIsoLocal(task.due_at) : null;
  const money = task.money_at_risk ?? 0;
  const firstStep = firstStepMinutes(task);
  const created = tryParseIsoLocal(task.created_at);
  const hoursOpen = created ? Math.max(0, hoursBetween(created, now)) : 0;

  const r1 =
    due !== null &&
    ((money > 0 && due.getTime() <= addHours(now, 24).getTime()) ||
      (HARD_DEADLINE_CATEGORIES.includes(task.category) && due.getTime() <= addHours(now, 12).getTime()));
  const r2 = due !== null && nextBlock !== null && nextBlock.start.getTime() > now.getTime() && due.getTime() <= nextBlock.end.getTime();
  const r3 = isBasicNeeds(task);
  const r4 = effectiveMinutes > 0 && firstStep <= effectiveMinutes;
  const r5 = due !== null && isAcademic(task.category) && due.getTime() <= addHours(now, 48).getTime();

  const rules: Record<RuleId, boolean> = {
    irreversible_loss: r1,
    fixed_block_collision: r2,
    basic_needs: r3,
    fits_window: r4,
    academic_deadline: r5,
  };
  const fired = RULE_IDS.filter((r) => rules[r]);
  const tiebreak = round4(0.99 * cost(task, 2, now, decay));
  const score = round4(fired.reduce((sum, r) => sum + RULE_WEIGHTS[r], 0) + tiebreak);

  const base = {
    task,
    due,
    firstStep,
    totalMinutes: totalMinutes(task),
    rules,
    fired,
    fits: r4,
    guard: balanceGuardFires(task, now),
    hoursOpen,
    tiebreak,
    score,
    curveKind: curveKindFor(task, decay),
  };
  return { ...base, evidence: buildEvidence(base, ctx) };
}

/** Score desc, then earliest due, then task_id (deterministic). */
export function compareEvals(a: TaskEval, b: TaskEval): number {
  if (b.score !== a.score) return b.score - a.score;
  const ad = a.due ? a.due.getTime() : Number.POSITIVE_INFINITY;
  const bd = b.due ? b.due.getTime() : Number.POSITIVE_INFINITY;
  if (ad !== bd) return ad - bd;
  return a.task.task_id < b.task.task_id ? -1 : a.task.task_id > b.task.task_id ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Evidence sentences (always cite numbers)
// ---------------------------------------------------------------------------

type EvidenceInput = Omit<TaskEval, 'evidence'>;

function away(now: Date, due: Date): string {
  return `${formatDuration(minutesBetween(now, due))} away`;
}

function evidenceIrreversible(e: EvidenceInput, ctx: RankContext): string {
  const { task, due } = e;
  const { now } = ctx;
  const money = task.money_at_risk ?? 0;
  const lead = mentionsRefund(task) ? `Refund of ${dollars(money)}` : dollars(money);
  if (due && money > 0) {
    if (e.rules.irreversible_loss) return `${lead} is lost ${formatDue(due, now)} (${away(now, due)}).`;
    return `${lead} is at stake, but not until ${formatWhen(due, now)} (${away(now, due)}), more than 24 hours out.`;
  }
  if (due && HARD_DEADLINE_CATEGORIES.includes(task.category)) {
    if (e.rules.irreversible_loss) return `Due ${formatDue(due, now)} (${away(now, due)}), and a missed deadline can't be undone.`;
    return `Due ${formatDue(due, now)} (${away(now, due)}), so nothing is lost for good in the next 12 hours.`;
  }
  if (due) return `No money at risk, and the ${formatWhen(due, now)} deadline (${away(now, due)}) isn't a hard loss.`;
  if (money > 0) return `${dollars(money)} is at stake but there's no deadline, so nothing is lost at a set time.`;
  return 'No deadline and $0 at risk, so nothing is lost for good by waiting.';
}

function evidenceCollision(e: EvidenceInput, ctx: RankContext): string {
  const { due } = e;
  const { now, nextBlock } = ctx;
  if (!nextBlock) return `No more classes or labs today after ${formatTime(now)}, so nothing cuts it off.`;
  const blockText = `${nextBlock.title} (${formatRange(nextBlock.start, nextBlock.end)})`;
  if (!due) return `No deadline, so ${blockText} doesn't cut it off.`;
  if (e.rules.fixed_block_collision) {
    return `Due ${formatDue(due, now)}, before ${nextBlock.title} ends at ${formatTime(nextBlock.end)}, so the ${ctx.effectiveMinutes} min you have before ${formatTime(nextBlock.start)} are the last chance.`;
  }
  return `Due ${formatDue(due, now)}, after ${nextBlock.title} ends at ${formatTime(nextBlock.end)}, so there's still time after it.`;
}

function evidenceBasicNeeds(e: EvidenceInput, ctx: RankContext): string {
  const { task } = e;
  const h = Math.floor(e.hoursOpen);
  if (!e.rules.basic_needs) return `It's ${categoryNoun(task.category)}, not food, sleep or health, so today's basics don't hinge on it.`;
  if (isGroceries(task)) {
    const m = ctx.money;
    if (m.daysUntilBudget !== null && m.budgetUntil) {
      return `Food for the week: ${dollars(m.cash)} has to last ${plural(m.daysUntilBudget, 'day')} until ${formatDay(m.budgetUntil, ctx.now)}.`;
    }
    return `Food for the week on ${dollars(m.cash)} of cash.`;
  }
  if (task.category === 'rest' || /sleep/i.test(`${task.raw_text} ${task.normalized_text}`)) {
    return task.defer_count > 0
      ? `Sleep keeps you functioning, and it's been put off ${times(task.defer_count)} in ${h} hours.`
      : `Sleep keeps you functioning, and this has been open for ${h} hours.`;
  }
  if (task.category === 'meal') return `Eating is a basic need, and this has been open for ${h} hours.`;
  return `It's a health or food need that has been open for ${h} hours.`;
}

function evidenceFits(e: EvidenceInput, ctx: RankContext): string {
  const eff = ctx.effectiveMinutes;
  if (eff <= 0) return `First step is ${e.firstStep} min, but there are 0 free minutes right now.`;
  if (e.rules.fits_window) return `First step is ${e.firstStep} min and you have ${eff} min free, ${eff - e.firstStep} to spare.`;
  return `First step is ${e.firstStep} min but you only have ${eff} min free, ${e.firstStep - eff} short.`;
}

function evidenceAcademic(e: EvidenceInput, ctx: RankContext): string {
  const { task, due } = e;
  if (!isAcademic(task.category)) return "It isn't coursework or a shift, so the 48-hour academic deadline check doesn't apply.";
  if (!due) return 'Coursework with no due date set, so the 48-hour check has nothing to measure.';
  if (e.rules.academic_deadline) return `Due ${formatDue(due, ctx.now)}, ${away(ctx.now, due)}, inside the 48-hour window.`;
  return `Due ${formatDue(due, ctx.now)}, ${away(ctx.now, due)}, beyond the 48-hour window.`;
}

export function buildEvidence(e: EvidenceInput, ctx: RankContext): RuleEvidence[] {
  const details: Record<RuleId, string> = {
    irreversible_loss: evidenceIrreversible(e, ctx),
    fixed_block_collision: evidenceCollision(e, ctx),
    basic_needs: evidenceBasicNeeds(e, ctx),
    fits_window: evidenceFits(e, ctx),
    academic_deadline: evidenceAcademic(e, ctx),
  };
  return RULE_IDS.map((rule) => ({ rule, label: RULE_LABELS[rule], fired: e.rules[rule], detail: details[rule] }));
}

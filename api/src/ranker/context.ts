import type { IsoDateTime } from '../types';
import { addMinutes, atTime, formatTime, minutesBetween, toIsoLocal, tryParseIsoLocal } from '../clock';

// Pivot 3: free time before the next protected commitment is a hard filter on "do now", not a weight.
// Everything here is deterministic, works from one frozen context, and every sentence is built from the numbers it checked.

export type ResultState = 'feasible' | 'conditional' | 'conflict' | 'needs_review';
export type Provenance = 'live_snowflake' | 'local_fallback' | 'seeded_demo' | 'backup_recording';

export interface Commitment {
  id: string;
  title: string;
  start: Date;
  end: Date;
  /** protected commitments are never overlapped or released to make something fit */
  protected: boolean;
  arrival_buffer_minutes: number;
}

export interface Segment {
  id: string;
  label: string;
  minutes: number;
}

export type PathStart = { kind: 'now' } | { kind: 'after'; commitment_id: string } | { kind: 'at'; commitment_id: string };

/** One supplied way to complete a task. Paths are never derived or recombined. */
export interface PathOption {
  id: string;
  label: string;
  start: PathStart;
  segments: Segment[];
  /** the path ends by arriving at this commitment, so it must finish by that commitment's arrival target */
  arrive_for: string | null;
}

export interface Step {
  label: string;
  minutes: number;
}

export interface ContextTask {
  id: string;
  title: string;
  deadline: Date | null;
  /** missing the deadline can't be undone */
  irreversible: boolean;
  /** remaining effort estimate; null means unknown, never zero */
  remaining_minutes: number | null;
  first_step: Step | null;
  /** a preparatory step never completes its task */
  prep_step: Step | null;
  paths: PathOption[];
  refund_at_risk_cents: number | null;
}

export interface Expense {
  id: string;
  label: string;
  cents: number;
}

export interface ContextFixture {
  scenario: string;
  timezone: string;
  /** simulated clock */
  now: Date;
  commitments: Commitment[];
  tasks: ContextTask[];
  money: { currency: string; cash_cents: number; reserve_cents: number; planned: Expense[] };
}

export interface MoneyCheck {
  currency: string;
  cash_cents: number;
  reserve_cents: number;
  spendable_cents: number;
  planned: Expense[];
  planned_total_cents: number;
  fits: boolean;
  over_by_cents: number;
  cash_after_plan_cents: number;
  /** a consequence, never spendable cash */
  refund_at_risk_cents: number | null;
}

export interface ContextSnapshot {
  scenario: string;
  request_id: string;
  revision: number;
  clock: 'simulated';
  timezone: string;
  now: IsoDateTime;
  next_commitment: {
    title: string;
    starts_at: IsoDateTime;
    ends_at: IsoDateTime;
    arrival_buffer_minutes: number;
    arrive_by: IsoDateTime;
  } | null;
  /** (next protected start - arrival buffer) - now, recomputed per request */
  computed_free_minutes: number;
  /** what the student said they have; it can only lower the computed value */
  stated_minutes: number | null;
  available_minutes: number;
  deadlines: Array<{ task_id: string; title: string; due_at: IsoDateTime; irreversible: boolean }>;
  money: MoneyCheck;
}

export interface PathCheck {
  task_id: string;
  path_id: string;
  label: string;
  starts_at: IsoDateTime;
  completes_at: IsoDateTime;
  minutes: number;
  segments: Segment[];
  /** paths that start now: finishes inside available_minutes */
  fits_window: boolean | null;
  meets_deadline: boolean | null;
  minutes_late: number;
  /** minutes between completion and the tightest limit it has; negative means a limit is broken */
  slack_minutes: number;
  violations: string[];
  /** latest start that still clears every limit, working back around protected commitments; null if none */
  latest_start: IsoDateTime | null;
  ok: boolean;
}

export interface TaskCheck {
  task_id: string;
  title: string;
  due_at: IsoDateTime | null;
  irreversible: boolean;
  status: ResultState;
  paths: PathCheck[];
  latest_feasible_start: IsoDateTime | null;
}

export type CandidateKind = 'complete' | 'first_step' | 'prep';

export interface Candidate {
  task_id: string;
  title: string;
  kind: CandidateKind;
  label: string;
  minutes: number;
  path_id: string | null;
  completes_task: boolean;
  fits: boolean;
  /** position in POLICY (1 = first choice) */
  policy_rank: number;
  rejected_because: string | null;
}

export interface OverrunInput {
  task_id: string;
  /** null for a first or preparatory step */
  path_id: string | null;
  segment_id: string;
  minutes: number;
}

export interface OverrunScenario {
  task_id: string;
  path_id: string | null;
  path_label: string;
  segment_id: string;
  segment_label: string;
  added_minutes: number;
  base_completes_at: IsoDateTime;
  base_slack_minutes: number;
  completes_at: IsoDateTime;
  slack_minutes: number;
  violations: string[];
  fits_only_without_overrun: boolean;
  summary: string;
}

export interface ContextPlan {
  snapshot: ContextSnapshot;
  provenance: Provenance;
  result_state: ResultState;
  do_now: Candidate | null;
  /** the one named segment "What if this takes 10 minutes longer?" applies to */
  overrun_target: { task_id: string; path_id: string | null; segment_id: string; label: string } | null;
  reason: string;
  warnings: string[];
  assumptions: string[];
  policy: string[];
  candidates: Candidate[];
  checks: TaskCheck[];
  /** hypothetical only; never changes do_now, tasks, money or history */
  scenario: OverrunScenario | null;
}

export interface ContextRequest {
  request_id: string;
  revision: number;
  stated_minutes: number | null;
  overrun?: OverrunInput | null;
  /** extra planned purchases to check together with the fixture's (deduplicated by id) */
  extra_expenses?: Expense[];
}

export const POLICY: readonly string[] = [
  'Hard filter: a do-now action must finish inside available_minutes and must not overlap a protected commitment.',
  'First choice: the complete action for an irreversible deadline when no later path meets it.',
  'Then: the complete action for any other task, earliest deadline first.',
  'Then: the first step of the earliest-due task.',
  'Last: a preparatory step, which never counts as completing its task.',
];

const MS = 60_000;
const fmt = formatTime;

function fmtIso(value: IsoDateTime): string {
  const d = tryParseIsoLocal(value);
  return d ? fmt(d) : value;
}

function lowerFirst(s: string): string {
  return s.length > 0 ? s.charAt(0).toLowerCase() + s.slice(1) : s;
}

export function formatCents(cents: number, currency: string): string {
  const sign = cents < 0 ? '-' : '';
  return `${currency} ${sign}${(Math.abs(cents) / 100).toFixed(2)}`;
}

function commitmentById(f: ContextFixture, id: string): Commitment {
  const c = f.commitments.find((x) => x.id === id);
  if (!c) throw new Error(`unknown commitment ${id}`);
  return c;
}

export function arriveBy(c: Commitment): Date {
  return addMinutes(c.start, -c.arrival_buffer_minutes);
}

export function nextProtectedCommitment(commitments: readonly Commitment[], now: Date): Commitment | null {
  return (
    [...commitments]
      .filter((c) => c.protected && c.start.getTime() > now.getTime())
      .sort((a, b) => a.start.getTime() - b.start.getTime())[0] ?? null
  );
}

/** available_minutes = (next protected start - arrival buffer) - now, capped by what the student said they have. */
export function computeAvailableMinutes(
  commitments: readonly Commitment[],
  now: Date,
  statedMinutes: number | null,
): { next: Commitment | null; computed: number; available: number } {
  const inProgress = commitments.some((c) => c.protected && c.start.getTime() <= now.getTime() && c.end.getTime() > now.getTime());
  const next = nextProtectedCommitment(commitments, now);
  let computed: number;
  if (inProgress) computed = 0;
  else if (next) computed = Math.max(0, Math.floor(minutesBetween(now, arriveBy(next))));
  else computed = Math.max(0, Math.floor(minutesBetween(now, atTime(now, '23:59'))));
  const available = statedMinutes === null ? computed : Math.max(0, Math.min(computed, Math.floor(statedMinutes)));
  return { next, computed, available };
}

/** Cumulative check: every planned expense counts once (by id), however often the plan reruns. A refund at risk is never added. */
export function checkSpending(money: ContextFixture['money'], extra: readonly Expense[] = [], refundAtRiskCents: number | null = null): MoneyCheck {
  const byId = new Map<string, Expense>();
  for (const e of [...money.planned, ...extra]) byId.set(e.id, e);
  const planned = [...byId.values()];
  const total = planned.reduce((sum, e) => sum + e.cents, 0);
  const spendable = Math.max(0, money.cash_cents - money.reserve_cents);
  return {
    currency: money.currency,
    cash_cents: money.cash_cents,
    reserve_cents: money.reserve_cents,
    spendable_cents: spendable,
    planned,
    planned_total_cents: total,
    fits: total <= spendable,
    over_by_cents: Math.max(0, total - spendable),
    cash_after_plan_cents: money.cash_cents - total,
    refund_at_risk_cents: refundAtRiskCents,
  };
}

function pathStartDate(f: ContextFixture, path: PathOption): Date {
  if (path.start.kind === 'now') return f.now;
  const c = commitmentById(f, path.start.commitment_id);
  return path.start.kind === 'after' ? c.end : c.start;
}

function ownCommitments(path: PathOption): Set<string> {
  const own = new Set<string>();
  if (path.arrive_for) own.add(path.arrive_for);
  if (path.start.kind !== 'now') own.add(path.start.commitment_id);
  return own;
}

function overlapsProtected(f: ContextFixture, own: Set<string>, start: number, end: number): Commitment | null {
  return f.commitments.find((c) => c.protected && !own.has(c.id) && start < c.end.getTime() && end > c.start.getTime()) ?? null;
}

/** Latest start that still finishes by every limit, working back around protected commitments. null when no start works or nothing bounds it. */
export function latestFeasibleStart(f: ContextFixture, task: ContextTask, path: PathOption, minutes: number, available: number): Date | null {
  const duration = minutes * MS;
  if (path.start.kind === 'at') {
    const c = commitmentById(f, path.start.commitment_id);
    const end = c.start.getTime() + duration;
    const ok = end <= c.end.getTime() && (!task.deadline || end <= task.deadline.getTime()) && !overlapsProtected(f, ownCommitments(path), c.start.getTime(), end);
    return ok ? c.start : null;
  }
  let finishBy = task.deadline ? task.deadline.getTime() : Number.POSITIVE_INFINITY;
  if (path.arrive_for) finishBy = Math.min(finishBy, arriveBy(commitmentById(f, path.arrive_for)).getTime());
  if (path.start.kind === 'now') finishBy = Math.min(finishBy, f.now.getTime() + available * MS);
  if (!Number.isFinite(finishBy)) return null;
  const earliest = path.start.kind === 'now' ? f.now.getTime() : commitmentById(f, path.start.commitment_id).end.getTime();
  const own = ownCommitments(path);
  let latest = finishBy - duration;
  for (let i = 0; i <= f.commitments.length; i++) {
    const hit = overlapsProtected(f, own, latest, latest + duration);
    if (!hit) break;
    latest = arriveBy(hit).getTime() - duration;
  }
  if (overlapsProtected(f, own, latest, latest + duration)) return null;
  return latest >= earliest ? new Date(latest) : null;
}

function applyOverrun(path: PathOption, overrun: OverrunInput | null): Segment[] {
  return path.segments.map((s) => (overrun && overrun.path_id === path.id && overrun.segment_id === s.id ? { ...s, minutes: s.minutes + overrun.minutes } : { ...s }));
}

export function checkPath(f: ContextFixture, task: ContextTask, path: PathOption, available: number, overrun: OverrunInput | null = null): PathCheck {
  const segments = applyOverrun(path, overrun && overrun.task_id === task.id ? overrun : null);
  const minutes = segments.reduce((sum, s) => sum + s.minutes, 0);
  const start = pathStartDate(f, path);
  const end = addMinutes(start, minutes);
  const violations: string[] = [];
  const slacks: number[] = [];

  let fitsWindow: boolean | null = null;
  if (path.start.kind === 'now') {
    const windowEnd = addMinutes(f.now, available);
    fitsWindow = end.getTime() <= windowEnd.getTime();
    slacks.push(Math.floor(minutesBetween(end, windowEnd)));
    if (!fitsWindow) violations.push(`needs ${minutes} min but you have ${available}`);
  }
  let meets: boolean | null = null;
  let late = 0;
  if (task.deadline) {
    meets = end.getTime() <= task.deadline.getTime();
    late = Math.max(0, Math.ceil(minutesBetween(task.deadline, end)));
    slacks.push(Math.floor(minutesBetween(end, task.deadline)));
    if (!meets) violations.push(`finishes at ${fmt(end)}, ${late} min after the ${fmt(task.deadline)} cutoff`);
  }
  if (path.arrive_for) {
    const c = commitmentById(f, path.arrive_for);
    const target = arriveBy(c);
    slacks.push(Math.floor(minutesBetween(end, target)));
    if (end.getTime() > target.getTime()) {
      violations.push(`arrives ${Math.ceil(minutesBetween(target, end))} min after the ${fmt(target)} arrival target for ${c.title}`);
    }
  }
  if (path.start.kind === 'at') {
    const c = commitmentById(f, path.start.commitment_id);
    slacks.push(Math.floor(minutesBetween(end, c.end)));
    if (end.getTime() > c.end.getTime()) violations.push(`runs ${Math.ceil(minutesBetween(c.end, end))} min past the ${fmt(c.start)}–${fmt(c.end)} block`);
  }
  const own = ownCommitments(path);
  for (const c of f.commitments) {
    if (!c.protected || own.has(c.id)) continue;
    if (start.getTime() < c.end.getTime() && end.getTime() > c.start.getTime()) {
      violations.push(`overlaps ${c.title} (${fmt(c.start)}–${fmt(c.end)})`);
    }
  }
  const latest = latestFeasibleStart(f, task, path, minutes, available);
  return {
    task_id: task.id,
    path_id: path.id,
    label: path.label,
    starts_at: toIsoLocal(start),
    completes_at: toIsoLocal(end),
    minutes,
    segments,
    fits_window: fitsWindow,
    meets_deadline: meets,
    minutes_late: late,
    slack_minutes: slacks.length > 0 ? Math.min(...slacks) : 0,
    violations,
    latest_start: latest ? toIsoLocal(latest) : null,
    ok: violations.length === 0,
  };
}

function checkTask(f: ContextFixture, task: ContextTask, available: number): TaskCheck {
  const paths = task.paths.map((p) => checkPath(f, task, p, available));
  let status: ResultState;
  if (paths.some((p) => p.ok)) status = 'feasible';
  else if (paths.length > 0) status = 'conflict';
  else status = 'conditional';
  const starts = paths.filter((p) => p.ok && p.latest_start !== null).map((p) => p.latest_start as string);
  starts.sort();
  return {
    task_id: task.id,
    title: task.title,
    due_at: task.deadline ? toIsoLocal(task.deadline) : null,
    irreversible: task.irreversible,
    status,
    paths,
    latest_feasible_start: starts[starts.length - 1] ?? null,
  };
}

function buildCandidates(f: ContextFixture, checks: readonly TaskCheck[], available: number): Candidate[] {
  const out: Candidate[] = [];
  for (const task of f.tasks) {
    const tc = checks.find((c) => c.task_id === task.id);
    if (!tc) continue;
    const laterPathWorks = tc.paths.some((pc) => pc.ok && task.paths.find((p) => p.id === pc.path_id)?.start.kind !== 'now');
    for (const pc of tc.paths) {
      const path = task.paths.find((p) => p.id === pc.path_id);
      if (!path || path.start.kind !== 'now') continue;
      out.push({
        task_id: task.id,
        title: task.title,
        kind: 'complete',
        label: path.label,
        minutes: pc.minutes,
        path_id: path.id,
        completes_task: true,
        fits: pc.ok,
        policy_rank: task.irreversible && task.deadline && !laterPathWorks ? 2 : 3,
        rejected_because: pc.ok ? null : pc.violations.join('; '),
      });
    }
    for (const [kind, step, rank] of [
      ['first_step', task.first_step, 4],
      ['prep', task.prep_step, 5],
    ] as const) {
      if (!step) continue;
      const fits = step.minutes <= available;
      out.push({
        task_id: task.id,
        title: task.title,
        kind,
        label: step.label,
        minutes: step.minutes,
        path_id: null,
        completes_task: kind === 'first_step' && task.remaining_minutes !== null && step.minutes >= task.remaining_minutes,
        fits,
        policy_rank: rank,
        rejected_because: fits ? null : `needs ${step.minutes} min but you have ${available}`,
      });
    }
  }
  const due = (c: Candidate): number => f.tasks.find((t) => t.id === c.task_id)?.deadline?.getTime() ?? Number.POSITIVE_INFINITY;
  return out.sort((a, b) => a.policy_rank - b.policy_rank || due(a) - due(b) || a.minutes - b.minutes || (a.task_id < b.task_id ? -1 : a.task_id > b.task_id ? 1 : 0));
}

function stepPhrase(c: Candidate): string {
  if (c.kind === 'prep') return `${lowerFirst(c.label)} (${c.minutes} min) fits instead, but it only prepares ${lowerFirst(c.title)} and does not complete it`;
  if (c.kind === 'first_step' && !c.completes_task) return `a ${c.minutes}-minute start on ${c.title} fits instead`;
  return `${lowerFirst(c.label)} (${c.minutes} min) fits instead`;
}

function buildReason(f: ContextFixture, snap: ContextSnapshot, next: Commitment | null, doNow: Candidate | null, blocked: Candidate | null, checks: readonly TaskCheck[]): string {
  const have = `You have ${snap.available_minutes} minutes${next ? ` before ${next.title}` : ''}`;
  if (!doNow) {
    return blocked
      ? `${have}, and the shortest option, ${lowerFirst(blocked.label)}, takes ${blocked.minutes}, so nothing fits right now.`
      : `${have}, and nothing on the list needs doing now.`;
  }
  if (blocked) return `${have}, and the full ${lowerFirst(blocked.label)} takes ${blocked.minutes}, so it can't happen now; ${stepPhrase(doNow)}.`;
  const task = f.tasks.find((t) => t.id === doNow.task_id);
  const tc = checks.find((c) => c.task_id === doNow.task_id);
  const pc = tc?.paths.find((p) => p.path_id === doNow.path_id);
  if (doNow.kind === 'complete' && doNow.policy_rank === 2 && task?.deadline && pc) {
    const later = tc?.paths.find((p) => p.path_id !== doNow.path_id && !p.ok && p.minutes_late > 0);
    const laterText = later
      ? `; ${lowerFirst(later.label)} would finish at ${fmtIso(later.completes_at)}, ${later.minutes_late} minutes past the ${fmt(task.deadline)} cutoff, which can't be undone`
      : `, and the ${fmt(task.deadline)} cutoff can't be undone`;
    return `${have}, and the full ${lowerFirst(doNow.label)} takes ${doNow.minutes}, done by ${fmtIso(pc.completes_at)}${laterText}, so now is the last window that works.`;
  }
  return `${have}, and ${lowerFirst(doNow.label)} takes ${doNow.minutes}, leaving ${snap.available_minutes - doNow.minutes} to spare.`;
}

function overrunTarget(f: ContextFixture, doNow: Candidate | null): ContextPlan['overrun_target'] {
  if (!doNow) return null;
  if (doNow.path_id) {
    const path = f.tasks.find((t) => t.id === doNow.task_id)?.paths.find((p) => p.id === doNow.path_id);
    const longest = path?.segments.reduce<Segment | null>((best, s) => (best === null || s.minutes > best.minutes ? s : best), null);
    return longest ? { task_id: doNow.task_id, path_id: doNow.path_id, segment_id: longest.id, label: longest.label } : null;
  }
  return { task_id: doNow.task_id, path_id: null, segment_id: doNow.kind === 'prep' ? 'prep_step' : 'first_step', label: doNow.label };
}

/** Same policy and checks, same frozen context; only the one named segment changes. Returns null for an unknown segment. */
export function overrunScenario(f: ContextFixture, available: number, input: OverrunInput): OverrunScenario | null {
  const task = f.tasks.find((t) => t.id === input.task_id);
  if (!task) return null;
  let pathLabel: string;
  let segmentLabel: string;
  let base: { end: Date; slack: number; ok: boolean };
  let over: { end: Date; slack: number; violations: string[]; ok: boolean };
  if (input.path_id === null) {
    const step = input.segment_id === 'first_step' ? task.first_step : input.segment_id === 'prep_step' ? task.prep_step : null;
    if (!step) return null;
    pathLabel = step.label;
    segmentLabel = step.label;
    const total = step.minutes + input.minutes;
    base = { end: addMinutes(f.now, step.minutes), slack: available - step.minutes, ok: step.minutes <= available };
    over = {
      end: addMinutes(f.now, total),
      slack: available - total,
      violations: total > available ? [`needs ${total} min but you have ${available}`] : [],
      ok: total <= available,
    };
  } else {
    const path = task.paths.find((p) => p.id === input.path_id);
    const segment = path?.segments.find((s) => s.id === input.segment_id);
    if (!path || !segment) return null;
    pathLabel = path.label;
    segmentLabel = segment.label;
    const b = checkPath(f, task, path, available);
    const o = checkPath(f, task, path, available, input);
    base = { end: tryParseIsoLocal(b.completes_at) ?? f.now, slack: b.slack_minutes, ok: b.ok };
    over = { end: tryParseIsoLocal(o.completes_at) ?? f.now, slack: o.slack_minutes, violations: o.violations, ok: o.ok };
  }
  const lead = `If ${lowerFirst(segmentLabel)} takes ${input.minutes} minutes longer, ${lowerFirst(pathLabel)} finishes at ${fmt(over.end)} instead of ${fmt(base.end)}`;
  let summary: string;
  if (over.ok) summary = `${lead}, with ${over.slack} minutes to spare.`;
  else if (base.ok) summary = `${lead}: ${over.violations.join('; ')}. It fits only without the overrun.`;
  else summary = `${lead}: ${over.violations.join('; ')}. It already didn't fit without the overrun.`;
  return {
    task_id: task.id,
    path_id: input.path_id,
    path_label: pathLabel,
    segment_id: input.segment_id,
    segment_label: segmentLabel,
    added_minutes: input.minutes,
    base_completes_at: toIsoLocal(base.end),
    base_slack_minutes: base.slack,
    completes_at: toIsoLocal(over.end),
    slack_minutes: over.slack,
    violations: over.violations,
    fits_only_without_overrun: base.ok && !over.ok,
    summary,
  };
}

/** Pure: the same fixture and request always give the same plan. */
export function buildContextPlan(f: ContextFixture, req: ContextRequest, provenance: Provenance = 'local_fallback'): ContextPlan {
  const { next, computed, available } = computeAvailableMinutes(f.commitments, f.now, req.stated_minutes);
  const refunds = f.tasks.map((t) => t.refund_at_risk_cents).filter((x): x is number => x !== null);
  const money = checkSpending(f.money, req.extra_expenses ?? [], refunds.length > 0 ? refunds.reduce((a, b) => a + b, 0) : null);

  const snapshot: ContextSnapshot = {
    scenario: f.scenario,
    request_id: req.request_id,
    revision: req.revision,
    clock: 'simulated',
    timezone: f.timezone,
    now: toIsoLocal(f.now),
    next_commitment: next
      ? {
          title: next.title,
          starts_at: toIsoLocal(next.start),
          ends_at: toIsoLocal(next.end),
          arrival_buffer_minutes: next.arrival_buffer_minutes,
          arrive_by: toIsoLocal(arriveBy(next)),
        }
      : null,
    computed_free_minutes: computed,
    stated_minutes: req.stated_minutes,
    available_minutes: available,
    deadlines: f.tasks
      .filter((t) => t.deadline !== null)
      .map((t) => ({ task_id: t.id, title: t.title, due_at: toIsoLocal(t.deadline as Date), irreversible: t.irreversible })),
    money,
  };

  const checks = f.tasks.map((t) => checkTask(f, t, available));
  const candidates = buildCandidates(f, checks, available);
  const doNow = candidates.find((c) => c.fits) ?? null;
  const blocked = candidates.find((c) => !c.fits && (doNow === null || c.policy_rank < doNow.policy_rank)) ?? null;

  const warnings: string[] = [];
  for (const tc of checks) {
    const task = f.tasks.find((t) => t.id === tc.task_id);
    if (tc.status !== 'conflict' || !task?.deadline) continue;
    const detail = tc.paths.map((p) => `${lowerFirst(p.label)} ${p.violations.join(' and ')}`).join('; ');
    warnings.push(`${tc.title}: no checked path meets the ${fmt(task.deadline)} cutoff (${detail}).`);
  }
  if (!money.fits) {
    warnings.push(
      `Planned spending of ${formatCents(money.planned_total_cents, money.currency)} is ${formatCents(money.over_by_cents, money.currency)} over the ${formatCents(money.spendable_cents, money.currency)} you can spend; the ${formatCents(money.reserve_cents, money.currency)} reserve stays protected.`,
    );
  }

  const assumptions: string[] = [];
  for (const task of f.tasks) {
    const tc = checks.find((c) => c.task_id === task.id);
    if (!tc || task.remaining_minutes === null) continue;
    const pc = tc.paths.find((p) => p.ok && task.paths.find((x) => x.id === p.path_id)?.start.kind === 'at');
    if (pc && task.deadline) {
      assumptions.push(`${task.title}: the ${task.remaining_minutes}-minute estimate fits ${lowerFirst(pc.label)}, finishing by ${fmtIso(pc.completes_at)}; this is a plan based on an estimate, not a guarantee.`);
    }
  }
  if (doNow?.kind === 'first_step') assumptions.push(`The ${doNow.minutes}-minute first step uses the ranker's first-step rule, not a measured duration.`);
  assumptions.push(
    `Planned spending of ${formatCents(money.planned_total_cents, money.currency)} leaves ${formatCents(money.cash_after_plan_cents, money.currency)} including the ${formatCents(money.reserve_cents, money.currency)} reserve; no refund is counted as cash.`,
  );

  let resultState: ResultState;
  if (f.commitments.length === 0) resultState = 'needs_review';
  else if (checks.some((c) => c.status === 'conflict' && c.irreversible) || !money.fits) resultState = 'conflict';
  else if (!doNow || checks.some((c) => c.status === 'conditional')) resultState = 'conditional';
  else resultState = 'feasible';

  const plan: ContextPlan = {
    snapshot,
    provenance,
    result_state: resultState,
    do_now: doNow,
    overrun_target: overrunTarget(f, doNow),
    reason: buildReason(f, snapshot, next, doNow, blocked, checks),
    warnings,
    assumptions,
    policy: [...POLICY],
    candidates,
    checks,
    scenario: null,
  };
  if (req.overrun) plan.scenario = overrunScenario(f, available, req.overrun);
  return plan;
}

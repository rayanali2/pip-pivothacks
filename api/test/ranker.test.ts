import { describe, expect, it } from 'vitest';
import type { Plan } from '../src/types';
import { addDays, isoDow, toIsoLocal } from '../src/clock';
import { buildPlan } from '../src/ranker/plan';
import { diffPlans } from '../src/ranker/diff';
import { computeFreeWindows } from '../src/ranker/windows';
import { cost, curvePoints } from '../src/ranker/decay';
import { parseContextFromQuestion } from '../src/ranker/questions';
import { demoBaseline, DEMO_TASK_IDS } from '../src/demo/scenario';
import { applyDemoCopy, detectDemoScenario, expectedStructure, planStructure } from '../src/demo/fixtures';

/** 13:13 local time on 7 consecutive days, so every ISO weekday is covered (independent of the real clock and TZ). */
const DAYS: Date[] = Array.from({ length: 7 }, (_, i) => new Date(2026, 8, 14 + i, 13, 13, 0, 0));

function demoPlans(now: Date): { base: Plan; rerank: Plan; tasks: ReturnType<typeof demoBaseline>['tasks'] } {
  const b = demoBaseline(now);
  const common = {
    student_id: 'demo',
    capture_id: 'demo-capture-seed',
    created_at: toIsoLocal(now),
    now,
    tasks: b.tasks,
    timetable: b.timetable,
    profile: b.profile,
    constraints: [],
  };
  const base = buildPlan({
    ...common,
    plan_id: 'plan-base',
    context: { available_minutes: null, cash_available: null, question: null },
    trigger: 'capture',
  });
  const rerank = buildPlan({
    ...common,
    plan_id: 'plan-rerank',
    context: { available_minutes: 25, cash_available: null, question: 'I only have 25 minutes' },
    trigger: 'rerank',
    previous_plan: base,
  });
  return { base, rerank, tasks: b.tasks };
}

function taskItems(plan: Plan) {
  return [plan.do_now, plan.next, ...plan.today, ...plan.can_wait].filter((i): i is NonNullable<typeof i> => i !== null && i.kind === 'task');
}

describe('demo ranker (CONTRACT section 5)', () => {
  for (const now of DAYS) {
    it(`base plan and 25-minute rerank at 13:13 on ISO weekday ${isoDow(now)}`, () => {
      const { base, rerank } = demoPlans(now);

      expect(base.do_now?.task_id).toBe('demo-return-headphones');
      expect(base.next?.kind).toBe('fixed_block');
      expect(base.next?.title).toBe('CHEM 110 Lab');
      expect(base.today.map((i) => i.item_id)).toEqual(['demo-assignment', 'demo-groceries', 'demo-sleep']);
      expect(base.can_wait.map((i) => i.item_id)).toEqual(['demo-club-rsvp', 'demo-laundry']);
      expect(base.reasoning.free_window?.label).toBe('47 min free until CHEM 110 Lab, 2:00 PM');
      expect(base.reasoning.effective_minutes).toBe(47);
      for (const item of taskItems(base)) expect(item.evidence).toHaveLength(5);
      expect(base.today.find((i) => i.item_id === 'demo-sleep')?.flag).toBe('balance_guard');
      expect(base.reasoning.days_until_budget).toBeGreaterThanOrEqual(1);

      expect(rerank.reasoning.effective_minutes).toBe(25);
      expect(rerank.do_now?.task_id).toBe('demo-assignment');
      expect(rerank.do_now?.task_id).not.toBe(base.do_now?.task_id);
      expect(rerank.today[0]?.item_id).toBe('demo-return-headphones');
      expect(rerank.today[0]?.flag).toBe('at_risk');
      expect(rerank.today[0]?.starts_at).toBeNull();
      expect(rerank.reasoning.warnings.length).toBeGreaterThan(0);
      for (const item of taskItems(rerank)) expect(item.evidence).toHaveLength(5);

      const diff = diffPlans(base, rerank);
      expect(diff.do_now_changed).toBe(true);
      expect(diff.previous_do_now_title).toBe(base.do_now?.title);
    });

    it(`structure equals DEMO_EXPECTED on ISO weekday ${isoDow(now)}`, () => {
      const { base, rerank, tasks } = demoPlans(now);
      const dow = isoDow(now);
      expect(planStructure(base)).toEqual(expectedStructure('base', dow));
      expect(planStructure(rerank)).toEqual(expectedStructure('rerank_25', dow));
      expect(detectDemoScenario(base, tasks, now)).toBe('base');
      expect(detectDemoScenario(rerank, tasks, now)).toBe('rerank_25');
    });
  }

  it('slots, scores, money math and copy for the demo', () => {
    const now = DAYS[0] ?? new Date(2026, 8, 14, 13, 13);
    const { base, rerank, tasks } = demoPlans(now);

    const at = (plan: Plan, id: string) => plan.today.find((i) => i.item_id === id);
    expect(at(base, 'demo-assignment')?.starts_at?.slice(11, 16)).toBe('17:15');
    expect(at(base, 'demo-assignment')?.ends_at?.slice(11, 16)).toBe('18:45');
    expect(at(base, 'demo-groceries')?.starts_at?.slice(11, 16)).toBe('19:00');
    expect(at(base, 'demo-groceries')?.ends_at?.slice(11, 16)).toBe('19:40');
    expect(at(base, 'demo-sleep')?.starts_at?.slice(11, 16)).toBe('23:30');
    expect(at(base, 'demo-sleep')?.ends_at).toBeNull();
    expect(at(rerank, 'demo-assignment#cont')?.starts_at?.slice(11, 16)).toBe('17:15');

    const score = (plan: Plan, id: string) => plan.reasoning.pre_rank.find((p) => p.task_id === id)?.score ?? -1;
    expect(Math.floor(score(base, DEMO_TASK_IDS.return))).toBe(11010);
    expect(Math.floor(score(base, DEMO_TASK_IDS.groceries))).toBe(110);
    expect(Math.floor(score(base, DEMO_TASK_IDS.sleep))).toBe(100);
    expect(Math.floor(score(base, DEMO_TASK_IDS.assignment))).toBe(11);
    expect(Math.floor(score(base, DEMO_TASK_IDS.club))).toBe(10);
    expect(Math.floor(score(base, DEMO_TASK_IDS.laundry))).toBe(0);
    expect(Math.floor(score(rerank, DEMO_TASK_IDS.return))).toBe(11000);
    expect(Math.floor(score(rerank, DEMO_TASK_IDS.groceries))).toBe(100);

    // Monday 2026-09-14 -> Friday 2026-09-18: 4 days, $35 / 4 = $8.75, cap $21
    expect(base.reasoning.budget_until).toBe('2026-09-18');
    expect(base.reasoning.days_until_budget).toBe(4);
    expect(base.reasoning.daily_budget).toBe(8.75);
    expect(at(base, 'demo-groceries')?.action).toContain('$21');

    // template why is one sentence citing the numbers
    expect(base.do_now?.why).toBe(
      "The $79 refund is gone at 5:00 PM and you're in CHEM 110 Lab from 2:00 to 5:00 PM, so the 35-minute return has to happen in the 47 minutes you have now.",
    );
    expect(base.next?.why).toContain('12 spare minutes');
    expect(rerank.next?.why).toContain('5 spare minutes');
    expect(rerank.reasoning.warnings[0]?.text).toContain('$79 refund at risk unless you find 10 more minutes');
    for (const item of [...taskItems(base), ...taskItems(rerank)]) {
      expect(item.why.trim().split(/(?<=[.!?])\s+(?=[A-Z])/)).toHaveLength(1);
      expect(item.why).not.toMatch(/score|\d{4,}\.\d/);
    }

    const copied = applyDemoCopy(base, tasks, { pinned: true, now });
    expect(copied.do_now?.title).toBe('Return headphones');
    expect(copied.do_now?.action).toBe('Grab the headphones and receipt and head to the store now (~35 min)');
    const copiedRerank = applyDemoCopy(rerank, tasks, { pinned: true, now });
    expect(copiedRerank.do_now?.title).toBe('Outline CS 101 assignment');
    // not pinned -> ranker templates stand
    expect(applyDemoCopy(base, tasks, { pinned: false, now }).do_now?.title).toBe('Return headphones for refund');
  });

  it('other times of day fall back to templates and never throw', () => {
    for (const hm of [
      [7, 5],
      [9, 45],
      [14, 30],
      [16, 59],
      [17, 30],
      [23, 50],
    ] as const) {
      const now = new Date(2026, 8, 16, hm[0], hm[1]);
      const { base, rerank } = demoPlans(now);
      expect(base.reasoning.now).toBe(toIsoLocal(now));
      for (const item of [...taskItems(base), ...taskItems(rerank)]) {
        expect(item.evidence).toHaveLength(5);
        expect(item.why.length).toBeGreaterThan(10);
      }
    }
  });
});

describe('ranker helpers', () => {
  it('free windows and labels', () => {
    const now = new Date(2026, 8, 14, 13, 13);
    const blocks = [
      { title: 'CHEM 110 Lecture', starts_at: '10:00', ends_at: '11:20', location: null },
      { title: 'CHEM 110 Lab', starts_at: '14:00', ends_at: '17:00', location: 'Science Hall 204' },
    ];
    const windows = computeFreeWindows(blocks, now);
    expect(windows[0]?.label).toBe('47 min free until CHEM 110 Lab, 2:00 PM');
    expect(windows[1]?.label).toBe('6 h 59 min free today');
    const inside = computeFreeWindows(blocks, new Date(2026, 8, 14, 15, 0));
    expect(inside[0]?.starts_at.slice(11, 16)).toBe('17:00');
  });

  it('decay curves', () => {
    const now = new Date(2026, 8, 14, 13, 13);
    const task = demoBaseline(now).tasks.find((t) => t.task_id === DEMO_TASK_IDS.return);
    if (!task) throw new Error('missing task');
    expect(cost(task, 0, now)).toBeCloseTo(0.1, 5);
    expect(cost(task, 4, now)).toBe(1);
    const pts = curvePoints(task, now);
    expect(pts).toHaveLength(12);
    expect(pts[0]?.hours).toBe(0);
  });

  it('parses minutes and cash from questions', () => {
    expect(parseContextFromQuestion('I only have 25 minutes.')).toEqual({ available_minutes: 25, cash_available: null });
    expect(parseContextFromQuestion('half an hour')).toEqual({ available_minutes: 30, cash_available: null });
    expect(parseContextFromQuestion('I have 2 hours and $20.50')).toEqual({ available_minutes: 120, cash_available: 20.5 });
    expect(parseContextFromQuestion('an hour')).toEqual({ available_minutes: 60, cash_available: null });
  });

  it('budget math uses the next Friday strictly after today', () => {
    const friday = new Date(2026, 8, 18, 13, 13);
    const { base } = demoPlans(friday);
    expect(base.reasoning.budget_until).toBe('2026-09-25');
    expect(base.reasoning.days_until_budget).toBe(7);
    const thursday = addDays(friday, -1);
    expect(demoPlans(thursday).base.reasoning.days_until_budget).toBe(1);
  });
});

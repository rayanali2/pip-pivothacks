import { afterAll, describe, expect, it } from 'vitest';
import { toIsoLocal } from '../src/clock';
import { buildPlan } from '../src/ranker/plan';
import { diffPlans } from '../src/ranker/diff';
import { heuristicExtract } from '../src/ranker/extract';
import { demoBaseline, DEMO_TRANSCRIPT } from '../src/demo/scenario';

// Vitest runs each test file in its own process (pool 'forks'), so changing TZ here cannot affect other files.
const ORIGINAL_TZ = process.env.TZ;

const ZONES: ReadonlyArray<[string, string]> = [
  ['Pacific/Kiritimati', '+14:00'],
  ['Pacific/Pago_Pago', '-11:00'],
  ['Asia/Kolkata', '+05:30'],
  ['America/Los_Angeles', '-07:00'],
  ['UTC', '+00:00'],
];

describe('demo plan is identical in any time zone', () => {
  afterAll(() => {
    if (ORIGINAL_TZ === undefined) delete process.env.TZ;
    else process.env.TZ = ORIGINAL_TZ;
  });

  for (const [zone, offset] of ZONES) {
    it(zone, () => {
      process.env.TZ = zone;
      const now = new Date(2026, 8, 16, 13, 13, 0, 0);
      expect(toIsoLocal(now)).toBe(`2026-09-16T13:13:00${offset}`);

      const b = demoBaseline(now);
      const common = {
        student_id: 'demo',
        capture_id: null,
        created_at: toIsoLocal(now),
        now,
        tasks: b.tasks,
        timetable: b.timetable,
        profile: b.profile,
        constraints: [],
      };
      const base = buildPlan({ ...common, plan_id: 'p1', context: { available_minutes: null, cash_available: null, question: null }, trigger: 'capture' });
      const rerank = buildPlan({
        ...common,
        plan_id: 'p2',
        context: { available_minutes: 25, cash_available: null, question: 'I only have 25 minutes' },
        trigger: 'rerank',
        previous_plan: base,
      });

      expect(base.reasoning.free_window?.label).toBe('47 min free until CHEM 110 Lab, 2:00 PM');
      expect(base.do_now?.task_id).toBe('demo-return-headphones');
      expect(base.today.map((i) => i.item_id)).toEqual(['demo-assignment', 'demo-groceries', 'demo-sleep']);
      expect(base.today[0]?.starts_at).toBe(`2026-09-16T17:15:00${offset}`);
      expect(rerank.do_now?.task_id).toBe('demo-assignment');
      expect(rerank.today[0]?.flag).toBe('at_risk');
      expect(diffPlans(base, rerank).do_now_changed).toBe(true);

      const extracted = heuristicExtract(DEMO_TRANSCRIPT, now, b.tasks);
      expect(extracted.tasks.map((t) => t.merge_into)).toEqual(['demo-return-headphones', 'demo-assignment', 'demo-groceries']);
      expect(extracted.constraints).toHaveLength(2);
    });
  }
});

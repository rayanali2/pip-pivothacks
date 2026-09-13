import { describe, expect, it } from 'vitest';
import { dateOnly, nextFridayAfter, toIsoLocal, atTime, addDays } from '../src/clock';
import { heuristicExtract } from '../src/ranker/extract';
import { demoBaseline, DEMO_TRANSCRIPT, DEMO_TASK_IDS } from '../src/demo/scenario';

describe('heuristicExtract', () => {
  const DAYS: Date[] = Array.from({ length: 7 }, (_, i) => new Date(2026, 8, 14 + i, 13, 13, 0, 0));

  for (const now of DAYS) {
    it(`demo transcript merges into the 3 existing tasks and yields 2 constraints (${dateOnly(now)})`, () => {
      const open = demoBaseline(now).tasks;
      const result = heuristicExtract(DEMO_TRANSCRIPT, now, open);

      expect(result.tasks.map((t) => t.merge_into)).toEqual([DEMO_TASK_IDS.return, DEMO_TASK_IDS.assignment, DEMO_TASK_IDS.groceries]);
      expect(result.tasks.every((t) => t.merge_into !== null)).toBe(true);

      const ret = result.tasks[0];
      expect(ret?.category).toBe('errand');
      expect(ret?.due_at).toBe(toIsoLocal(atTime(now, '17:00')));
      const assignment = result.tasks[1];
      expect(assignment?.category).toBe('assignment');
      expect(assignment?.due_at).toBe(toIsoLocal(atTime(addDays(now, 1), '23:59')));

      expect(result.constraints).toEqual([
        { kind: 'fixed_block', value: { title: 'Lab', starts_at: '14:00', ends_at: null, location: null } },
        { kind: 'cash', value: { amount: 35, until: dateOnly(nextFridayAfter(now)) } },
      ]);
      expect(result.question).toBe('What should I do?');
    });
  }

  it('general heuristics: new tasks, time window, categories', () => {
    const now = new Date(2026, 8, 16, 10, 0);
    const open = demoBaseline(now).tasks;
    const r = heuristicExtract(
      'I only have 25 minutes. I need to pick up my prescription by 6 PM and call mom tonight. My shift starts Friday at 9 AM. What should I do first?',
      now,
      open,
    );
    expect(r.constraints).toEqual([{ kind: 'time_window', value: { minutes: 25 } }]);
    const cats = r.tasks.map((t) => t.category);
    expect(cats).toContain('errand');
    expect(cats).toContain('social');
    expect(cats).toContain('work');
    expect(r.tasks.every((t) => t.merge_into === null)).toBe(true);
    const rx = r.tasks.find((t) => /prescription/i.test(t.raw_text));
    expect(rx?.due_at).toBe(toIsoLocal(atTime(now, '18:00')));
  });

  it('does not merge different tasks of the same category', () => {
    const now = new Date(2026, 8, 16, 10, 0);
    const open = demoBaseline(now).tasks;
    const r = heuristicExtract('I need to return library books by Friday.', now, open);
    expect(r.tasks).toHaveLength(1);
    expect(r.tasks[0]?.merge_into).toBeNull();
  });
});

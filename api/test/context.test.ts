import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app';
import { formatTime, tryParseIsoLocal } from '../src/clock';
import { buildContextPlan, checkPath, checkSpending, overrunScenario, type ContextFixture, type ContextPlan } from '../src/ranker/context';
import { pivot3Fixture } from '../src/demo/pivot3';
import { mockService } from './helpers';

function plan(stated: number | null, f: ContextFixture = pivot3Fixture()): ContextPlan {
  return buildContextPlan(f, { request_id: `test-${stated ?? 'full'}`, revision: 1, stated_minutes: stated });
}

function time(iso: string | null | undefined): string {
  const d = iso ? tryParseIsoLocal(iso) : null;
  return d ? formatTime(d) : 'none';
}

function task(f: ContextFixture, id: string) {
  const t = f.tasks.find((x) => x.id === id);
  if (!t) throw new Error(`missing task ${id}`);
  return t;
}

function path(f: ContextFixture, taskId: string, pathId: string) {
  const p = task(f, taskId).paths.find((x) => x.id === pathId);
  if (!p) throw new Error(`missing path ${pathId}`);
  return p;
}

describe('Pivot 3: available time is a hard planning constraint', () => {
  it('computes available_minutes from the timetable, arrival buffer and simulated clock', () => {
    const full = plan(null);
    expect(full.snapshot.clock).toBe('simulated');
    expect(time(full.snapshot.now)).toBe('12:40 PM');
    expect(time(full.snapshot.next_commitment?.arrive_by)).toBe('1:50 PM');
    expect(full.snapshot.computed_free_minutes).toBe(70);
    expect(full.snapshot.available_minutes).toBe(70);
    // a stated number can only lower the computed window, never raise it
    expect(plan(500).snapshot.available_minutes).toBe(70);
  });

  it('1. available_minutes = 48 -> do_now is the headphones return', () => {
    const a = plan(48);
    expect(a.snapshot.available_minutes).toBe(48);
    expect(a.do_now?.task_id).toBe('return-headphones');
    expect(a.do_now?.kind).toBe('complete');
    expect(a.do_now?.minutes).toBe(40);
    const before = a.checks.find((c) => c.task_id === 'return-headphones')?.paths.find((p) => p.path_id === 'before-lab');
    expect(time(before?.completes_at)).toBe('1:20 PM');
    expect(before?.ok).toBe(true);
    expect(a.reason).toContain('48 minutes');
    expect(a.reason).toContain('5:00 PM');
    expect(a.reason).toContain("can't be undone");
    expect(a.result_state).toBe('feasible');
  });

  it('2. available_minutes = 25 -> do_now is not the full return outing and the reason cites the 25-minute window', () => {
    const b = plan(25);
    expect(b.snapshot.available_minutes).toBe(25);
    expect(b.do_now).not.toBeNull();
    expect(b.do_now?.path_id).not.toBe('before-lab');
    expect(b.do_now?.minutes).toBeLessThanOrEqual(25);
    expect(b.reason).toContain('25 minutes');
    expect(b.reason).toContain('takes 40');
    const outing = b.candidates.find((c) => c.path_id === 'before-lab');
    expect(outing?.fits).toBe(false);
    expect(outing?.rejected_because).toContain('needs 40 min but you have 25');
    expect(b.result_state).toBe('conflict');
    expect(b.do_now?.task_id).not.toBe(plan(48).do_now?.task_id);
  });

  it('3. lab ends 4:45 PM -> the after-lab return completes 5:15 PM and misses the 5:00 PM cutoff', () => {
    const f = pivot3Fixture();
    const after = checkPath(f, task(f, 'return-headphones'), path(f, 'return-headphones', 'after-lab'), 48);
    expect(time(after.starts_at)).toBe('4:45 PM');
    expect(time(after.completes_at)).toBe('5:15 PM');
    expect(after.meets_deadline).toBe(false);
    expect(after.minutes_late).toBe(15);
    expect(after.latest_start).toBeNull();
    expect(after.violations.join(' ')).toContain('15 min after the 5:00 PM cutoff');
  });

  it('4. CAD 18 groceries + CAD 8 optional purchase exceeds CAD 25 spendable even though each fits alone', () => {
    const f = pivot3Fixture();
    const groceriesOnly = checkSpending(f.money);
    expect(groceriesOnly.spendable_cents).toBe(2500);
    expect(groceriesOnly.fits).toBe(true);
    expect(groceriesOnly.cash_after_plan_cents).toBe(1700);
    expect(groceriesOnly.refund_at_risk_cents).toBeNull();
    const optionalOnly = checkSpending({ ...f.money, planned: [] }, [{ id: 'optional', label: 'Optional purchase', cents: 800 }]);
    expect(optionalOnly.fits).toBe(true);
    const both = checkSpending(f.money, [{ id: 'optional', label: 'Optional purchase', cents: 800 }]);
    expect(both.planned_total_cents).toBe(2600);
    expect(both.fits).toBe(false);
    expect(both.over_by_cents).toBe(100);
    expect(both.reserve_cents).toBe(1000);
    // re-adding the same expense id does not deduct it twice
    expect(checkSpending(f.money, [{ id: 'groceries', label: 'Groceries', cents: 1800 }]).planned_total_cents).toBe(1800);
    const p = buildContextPlan(f, { request_id: 'money', revision: 1, stated_minutes: 48, extra_expenses: [{ id: 'optional', label: 'Optional purchase', cents: 800 }] });
    expect(p.result_state).toBe('conflict');
    expect(p.warnings.join(' ')).toContain('CAD 1.00 over the CAD 25.00');
  });

  it('5. a preparatory step is not reported as completing the return', () => {
    // test-only variant: the student supplies a 5-minute prep step and there is no other task
    const f = pivot3Fixture();
    const ret = task(f, 'return-headphones');
    const variant: ContextFixture = { ...f, tasks: [{ ...ret, prep_step: { label: 'Pack the headphones and receipt', minutes: 5 } }] };
    const b = plan(25, variant);
    expect(b.do_now?.kind).toBe('prep');
    expect(b.do_now?.completes_task).toBe(false);
    expect(b.checks.find((c) => c.task_id === 'return-headphones')?.status).toBe('conflict');
    expect(b.result_state).toBe('conflict');
    expect(b.reason).toContain('does not complete it');
    expect(b.warnings.join(' ')).toContain('no checked path meets the 5:00 PM cutoff');
  });

  it('assignment estimate fits the 6:00-8:00 PM block and is stated as an estimate', () => {
    const a = plan(48);
    const assignment = a.checks.find((c) => c.task_id === 'cs101-assignment');
    expect(assignment?.status).toBe('feasible');
    expect(a.assumptions.join(' ')).toContain('120-minute estimate');
    expect(a.assumptions.join(' ')).toContain('not a guarantee');
  });
});

describe('F4: what if one named segment takes 10 minutes longer', () => {
  it('+10 min on the 20-minute after-lab travel segment moves completion to 5:25 PM', () => {
    const f = pivot3Fixture();
    const s = overrunScenario(f, 48, { task_id: 'return-headphones', path_id: 'after-lab', segment_id: 'campus-to-shop', minutes: 10 });
    expect(time(s?.base_completes_at)).toBe('5:15 PM');
    expect(time(s?.completes_at)).toBe('5:25 PM');
    expect(s?.violations.join(' ')).toContain('25 min after the 5:00 PM cutoff');
    expect(s?.fits_only_without_overrun).toBe(false);
    // only the named segment changed; processing is not stretched and no travel is counted twice
    expect(f.tasks.find((t) => t.id === 'return-headphones')?.paths.find((p) => p.id === 'after-lab')?.segments.map((x) => x.minutes)).toEqual([20, 10]);
  });

  it('State A return fits only without the overrun, and do_now is unchanged by the preview', () => {
    const f = pivot3Fixture();
    const base = plan(48, f);
    const target = base.overrun_target;
    expect(target?.segment_id).toBe('home-to-shop');
    if (!target) throw new Error('missing overrun target');
    const withScenario = buildContextPlan(f, { request_id: 'test-48', revision: 1, stated_minutes: 48, overrun: { ...target, minutes: 10 } });
    expect(withScenario.do_now).toEqual(base.do_now);
    expect(withScenario.snapshot).toEqual(base.snapshot);
    expect(time(withScenario.scenario?.completes_at)).toBe('1:30 PM');
    expect(withScenario.scenario?.slack_minutes).toBe(-2);
    expect(withScenario.scenario?.fits_only_without_overrun).toBe(true);
    expect(withScenario.scenario?.summary).toContain('fits only without the overrun');
    expect(withScenario.scenario?.summary).not.toMatch(/%|probab|confiden/i);
  });
});

describe('Pivot 3 HTTP: snapshots are persisted, retrievable and idempotent', () => {
  it('preview never stores a plan or changes history', async () => {
    const app = createApp(mockService());
    await request(app).post('/context/plan').send({ request_id: 'req-preview-0001', stated_minutes: 25 });
    const before = await request(app).get('/context/history');
    const preview = await request(app)
      .post('/context/preview')
      .send({ plan_request_id: 'req-preview-0001', overrun: { task_id: 'cs101-assignment', path_id: null, segment_id: 'first_step', minutes: 10 } });
    expect(preview.status).toBe(200);
    expect(preview.body.plan.scenario.violations[0]).toContain('needs 30 min but you have 25');
    const after = await request(app).get('/context/history');
    expect(after.body).toEqual(before.body);
    const bad = await request(app).post('/context/preview').send({ plan_request_id: 'req-preview-0001', overrun: { task_id: 'cs101-assignment', path_id: 'nope', segment_id: 'x', minutes: 10 } });
    expect(bad.status).toBe(400);
  });

  it('stores State A and State B with different inputs and replays a repeated request id', async () => {
    const app = createApp(mockService());
    const a = await request(app).post('/context/plan').send({ request_id: 'req-state-a-0001', stated_minutes: 48 });
    const b = await request(app).post('/context/plan').send({ request_id: 'req-state-b-0001', stated_minutes: 25 });
    const again = await request(app).post('/context/plan').send({ request_id: 'req-state-b-0001', stated_minutes: 25 });
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(again.body.replayed).toBe(true);
    expect(a.body.plan.provenance).toBe('local_fallback');

    const start = await request(app).post('/context/actions').send({ request_id: 'act-start-0001', plan_request_id: 'req-state-b-0001', kind: 'start_now' });
    const startAgain = await request(app).post('/context/actions').send({ request_id: 'act-start-0001', plan_request_id: 'req-state-b-0001', kind: 'start_now' });
    expect(start.status).toBe(200);
    expect(startAgain.body.replayed).toBe(true);

    const history = await request(app).get('/context/history');
    const entries = history.body.entries as Array<{ request_id: string; plan: ContextPlan; actions: unknown[] }>;
    expect(entries.map((e) => e.request_id)).toEqual(['req-state-b-0001', 'req-state-a-0001']);
    const [eb, ea] = entries;
    expect(ea?.plan.snapshot.available_minutes).toBe(48);
    expect(eb?.plan.snapshot.available_minutes).toBe(25);
    expect(ea?.plan.snapshot.revision).toBe(1);
    expect(eb?.plan.snapshot.revision).toBe(2);
    expect(ea?.plan.do_now?.task_id).not.toBe(eb?.plan.do_now?.task_id);
    expect(eb?.actions).toHaveLength(1);
  });
});

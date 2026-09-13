import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app';
import { mockService } from './helpers';

function bodyOf(res: request.Response): Record<string, unknown> {
  const b: unknown = res.body;
  if (typeof b !== 'object' || b === null || Array.isArray(b)) throw new Error(`expected JSON object, got ${res.text}`);
  return b as Record<string, unknown>;
}

function str(v: unknown): string {
  if (typeof v !== 'string') throw new Error(`expected string, got ${JSON.stringify(v)}`);
  return v;
}

interface PlanShape {
  plan_id: string;
  do_now: { task_id: string | null; title: string } | null;
  today: Array<{ item_id: string; flag: string | null }>;
}

function planOf(v: unknown): PlanShape {
  if (typeof v !== 'object' || v === null) throw new Error('expected plan');
  return v as PlanShape;
}

describe('HTTP API in mock mode', () => {
  it('serves every endpoint with a source field', async () => {
    const app = createApp(mockService());
    const agent = request(app);

    const health = await agent.get('/health');
    expect(health.status).toBe(200);
    expect(bodyOf(health).source).toBe('fallback');
    expect(bodyOf(health).mode).toBe('mock');

    const voice = await agent
      .post('/captures/voice')
      .field('student_id', 'demo')
      .attach('audio', Buffer.from('not really audio'), { filename: 'capture.m4a', contentType: 'audio/m4a' });
    expect(voice.status).toBe(200);
    const vb = bodyOf(voice);
    expect(vb.source).toBe('fallback');
    const capturePlan = planOf(vb.plan);
    expect(capturePlan.do_now?.task_id).toBe('demo-return-headphones');
    expect(vb.diff).toBeNull();

    const text = await agent.post('/captures/text').send({ student_id: 'demo', text: 'I need to do laundry.' });
    expect(text.status).toBe(200);
    expect(bodyOf(text).source).toBe('fallback');

    const rerank = await agent
      .post('/plans/rerank')
      .send({ student_id: 'demo', plan_id: capturePlan.plan_id, context: { question: 'I only have 25 minutes' } });
    expect(rerank.status).toBe(200);
    const rb = bodyOf(rerank);
    expect(rb.source).toBe('fallback');
    const rerankPlan = planOf(rb.plan);
    expect(rerankPlan.do_now?.task_id).toBe('demo-assignment');
    expect(rerankPlan.do_now?.task_id).not.toBe(capturePlan.do_now?.task_id);
    expect(rb.previous_plan_id).toBe(capturePlan.plan_id);
    const diff = rb.diff as { do_now_changed: boolean; headline: string };
    expect(diff.do_now_changed).toBe(true);
    expect(diff.headline).toBe(
      "Only 25 min: the 35-min headphones return won't fit before Lab ($79 at risk), so do now is the assignment outline.",
    );

    const followup = await agent
      .post('/captures/voice')
      .field('student_id', 'demo')
      .field('followup_plan_id', capturePlan.plan_id)
      .attach('audio', Buffer.from('x'), { filename: 'f.m4a', contentType: 'audio/m4a' });
    expect(followup.status).toBe(200);
    expect(bodyOf(followup).transcript).toBe('I only have 25 minutes.');
    expect(bodyOf(followup).previous_plan_id).toBe(capturePlan.plan_id);
    expect(bodyOf(followup).diff).not.toBeNull();

    const action = await agent
      .post('/actions')
      .send({ student_id: 'demo', plan_id: rerankPlan.plan_id, task_id: rerankPlan.do_now?.task_id ?? null, kind: 'start_now' });
    expect(action.status).toBe(200);
    const ab = bodyOf(action);
    expect(ab.source).toBe('fallback');
    const actionId = str((ab.action as { action_id: unknown }).action_id);

    const history = await agent.get('/history').query({ student_id: 'demo' });
    expect(history.status).toBe(200);
    const hb = bodyOf(history);
    expect(hb.source).toBe('fallback');
    const entries = hb.entries as Array<{ plan_id: string; changed: string; actions: Array<{ action_id: string; task_title: string | null }> }>;
    const entry = entries.find((e) => e.plan_id === rerankPlan.plan_id);
    expect(entry?.actions.map((a) => a.action_id)).toContain(actionId);
    expect(entry?.actions[0]?.task_title).toBe('Outline CS 101 assignment');
    expect(entries[entries.length - 1]?.changed).toBe('first plan');

    const today = await agent.get('/timetable/today').query({ student_id: 'demo' });
    expect(today.status).toBe(200);
    expect(bodyOf(today).source).toBe('fallback');
    expect((bodyOf(today).next_free_window as { label: string }).label).toBe('47 min free until CHEM 110 Lab, 2:00 PM');

    const week = await agent.get('/timetable').query({ student_id: 'demo' });
    expect(week.status).toBe(200);
    expect((bodyOf(week).blocks as unknown[]).length).toBe(6);

    const putWeek = await agent.put('/timetable').send({
      student_id: 'demo',
      blocks: [{ day_of_week: 1, title: 'CHEM 110 Lecture', starts_at: '10:00', ends_at: '11:20', location: 'Science Hall 120' }],
    });
    expect(putWeek.status).toBe(200);
    expect(bodyOf(putWeek).source).toBe('fallback');
    expect((bodyOf(putWeek).blocks as unknown[]).length).toBe(1);

    const profile = await agent.get('/profile').query({ student_id: 'demo' });
    expect(profile.status).toBe(200);
    expect(bodyOf(profile).source).toBe('fallback');

    const putProfile = await agent.put('/profile').send({ student_id: 'demo', cash_available: 50, chronotype: 'neutral' });
    expect(putProfile.status).toBe(200);
    const pp = bodyOf(putProfile).profile as { cash_available: number; chronotype: string; cooks_own_meals: boolean };
    expect(pp.cash_available).toBe(50);
    expect(pp.chronotype).toBe('neutral');
    expect(pp.cooks_own_meals).toBe(true);

    const pivots = await agent.get('/pivot-log');
    expect(pivots.status).toBe(200);
    expect(bodyOf(pivots).source).toBe('fallback');
    expect((bodyOf(pivots).entries as Array<{ pivot_number: number }>).map((e) => e.pivot_number)).toEqual([1, 2]);

    const newPivot = await agent.post('/pivot-log').send({
      pivot_number: 3,
      revealed: 'Test',
      assumption_changed: 'Test',
      response: 'Test',
      cut: 'None',
      sentence: null,
    });
    expect(newPivot.status).toBe(200);
    expect(bodyOf(newPivot).source).toBe('fallback');

    const reset = await agent.post('/demo/reset').send({ student_id: 'demo' });
    expect(reset.status).toBe(200);
    expect(bodyOf(reset)).toEqual({ source: 'fallback', ok: true });
    const afterReset = await agent.get('/timetable').query({ student_id: 'demo' });
    expect((bodyOf(afterReset).blocks as unknown[]).length).toBe(6);
    const historyAfterReset = await agent.get('/history').query({ student_id: 'demo' });
    expect((bodyOf(historyAfterReset).entries as unknown[]).length).toBe(1);
  });

  it('returns 400 {source, error} on invalid input and 404 on unknown routes', async () => {
    const app = createApp(mockService());
    const bad = await request(app).post('/plans/rerank').send({ student_id: 'demo' });
    expect(bad.status).toBe(400);
    expect(bodyOf(bad).source).toBe('fallback');
    expect(typeof bodyOf(bad).error).toBe('string');

    const badAction = await request(app).post('/actions').send({ student_id: 'demo', plan_id: 'p', task_id: null, kind: 'explode' });
    expect(badAction.status).toBe(400);

    const badJson = await request(app).post('/captures/text').set('Content-Type', 'application/json').send('{"student_id":');
    expect(badJson.status).toBe(400);
    expect(bodyOf(badJson).source).toBe('fallback');

    const wrongField = await request(app)
      .post('/captures/voice')
      .field('student_id', 'demo')
      .attach('recording', Buffer.from('x'), { filename: 'f.m4a', contentType: 'audio/m4a' });
    expect(wrongField.status).toBe(400);

    const missing = await request(app).get('/nope');
    expect(missing.status).toBe(404);
  });

  it('applies action status changes', async () => {
    const app = createApp(mockService());
    const cap = await request(app).post('/captures/text').send({ student_id: 'demo', text: 'What should I do?' });
    const plan = planOf(bodyOf(cap).plan);
    const done = await request(app).post('/actions').send({ student_id: 'demo', plan_id: plan.plan_id, task_id: 'demo-laundry', kind: 'defer' });
    const task = bodyOf(done).task as { status: string; defer_count: number };
    expect(task.status).toBe('deferred');
    expect(task.defer_count).toBe(1);
  });
});

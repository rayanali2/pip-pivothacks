import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app';
import type { Backend } from '../src/backends/backend';
import { DEMO_TRANSCRIPT } from '../src/demo/scenario';
import type { CaptureResponse, HistoryResponse, PipelineStage, Plan, PlanItem, RerankResponse } from '../src/types';
import { liveServiceWith, mockService } from './helpers';

function capture(res: request.Response): CaptureResponse {
  expect(res.status).toBe(200);
  return res.body as CaptureResponse;
}

function rerank(res: request.Response): RerankResponse {
  expect(res.status).toBe(200);
  return res.body as RerankResponse;
}

function history(res: request.Response): HistoryResponse {
  expect(res.status).toBe(200);
  return res.body as HistoryResponse;
}

function byId(pipeline: PipelineStage[], id: PipelineStage['id']): PipelineStage {
  const s = pipeline.find((p) => p.id === id);
  if (!s) throw new Error(`missing ${id} stage`);
  return s;
}

function items(plan: Plan): PlanItem[] {
  return [plan.do_now, plan.next, ...plan.today, ...plan.can_wait].filter((i): i is PlanItem => i !== null);
}

const IDS = ['transcribe', 'extract', 'rank', 'wording'];
const LABELS = ['Heard you', 'Pulled out tasks', 'Ranked against 5 rules', 'Wrote your plan'];

describe('pipeline trace in mock mode', () => {
  it('text capture: Typed -> Heuristic parser -> Deterministic 5-rule ranker -> Templates, with extract chips', async () => {
    const agent = request(createApp(mockService()));
    const res = capture(await agent.post('/captures/text').send({ student_id: 'demo', text: DEMO_TRANSCRIPT }));

    expect(res.pipeline.map((s) => s.id)).toEqual(IDS);
    expect(res.pipeline.map((s) => s.label)).toEqual(LABELS);
    expect(res.pipeline.map((s) => s.engine)).toEqual(['Typed', 'Heuristic parser', 'Deterministic 5-rule ranker', 'Templates']);
    expect(res.pipeline.every((s) => s.status === 'ok')).toBe(true);

    const transcribe = byId(res.pipeline, 'transcribe');
    expect(transcribe.ms).toBeNull();
    expect(transcribe.detail).toBe('36 words');

    const extract = byId(res.pipeline, 'extract');
    expect(extract.detail).toBe('3 tasks · 2 constraints');
    expect(typeof extract.ms).toBe('number');
    const labels = extract.chips.map((c) => c.label);
    expect(labels.slice(0, 4)).toEqual(['Return headphones for refund · $79 · 5:00 PM', 'Finish CS 101 assignment · tomorrow', 'Buy groceries within budget', 'Lab 2:00 PM']);
    expect(labels[4]).toMatch(/^\$35 until (tomorrow|Fri|next Friday)$/);
    expect(labels[5]).toBe('What should I do?');
    expect(extract.chips.map((c) => c.kind)).toEqual(['task', 'task', 'task', 'fixed_block', 'cash', 'question']);

    expect(byId(res.pipeline, 'rank').detail).toBe('6 tasks scored · do now: Return headphones');
    expect(byId(res.pipeline, 'wording').detail).toMatch(/^\d+ items \+ summary$/);
    for (const s of res.pipeline.filter((p) => p.id !== 'extract')) expect(s.chips).toEqual([]);
  });

  it('voice capture: demo transcript without client_transcript, the on-device transcript with it', async () => {
    const agent = request(createApp(mockService()));
    const canned = capture(
      await agent
        .post('/captures/voice')
        .field('student_id', 'demo')
        .attach('audio', Buffer.from('x'), { filename: 'capture.m4a', contentType: 'audio/m4a' }),
    );
    expect(canned.transcript).toBe(DEMO_TRANSCRIPT);
    expect(byId(canned.pipeline, 'transcribe')).toMatchObject({ engine: 'Demo transcript (mock mode)', status: 'ok' });
    expect(typeof byId(canned.pipeline, 'transcribe').ms).toBe('number');

    const blank = capture(
      await agent
        .post('/captures/voice')
        .field('student_id', 'demo')
        .field('client_transcript', '   ')
        .attach('audio', Buffer.from('x'), { filename: 'capture.m4a', contentType: 'audio/m4a' }),
    );
    expect(blank.transcript).toBe(DEMO_TRANSCRIPT);

    const spoken = 'I need to do laundry tonight.';
    const device = capture(
      await agent
        .post('/captures/voice')
        .field('student_id', 'demo')
        .field('client_transcript', spoken)
        .attach('audio', Buffer.from('x'), { filename: 'capture.m4a', contentType: 'audio/m4a' }),
    );
    expect(device.transcript).toBe(spoken);
    expect(device.capture.source).toBe('voice');
    expect(byId(device.pipeline, 'transcribe')).toMatchObject({ engine: 'On-device speech (iOS)', status: 'ok', ms: null, detail: '6 words' });
    expect(byId(device.pipeline, 'extract').detail).toBe('1 task · 0 constraints');

    const followup = capture(
      await agent
        .post('/captures/voice')
        .field('student_id', 'demo')
        .field('followup_plan_id', canned.plan.plan_id)
        .field('client_transcript', 'I only have 25 minutes')
        .attach('audio', Buffer.from('x'), { filename: 'f.m4a', contentType: 'audio/m4a' }),
    );
    expect(followup.transcript).toBe('I only have 25 minutes');
    expect(followup.previous_plan_id).toBe(canned.plan.plan_id);
    expect(byId(followup.pipeline, 'transcribe').engine).toBe('On-device speech (iOS)');
    expect(byId(followup.pipeline, 'extract').detail).toBe('0 tasks · 1 constraint');
  });

  it('rerank: transcribe skipped, question parsed by the heuristic parser, ranker and templates', async () => {
    const agent = request(createApp(mockService()));
    const cap = capture(await agent.post('/captures/text').send({ student_id: 'demo', text: DEMO_TRANSCRIPT }));
    const res = rerank(await agent.post('/plans/rerank').send({ student_id: 'demo', plan_id: cap.plan.plan_id, context: { question: 'I only have 25 minutes' } }));

    expect(res.pipeline.map((s) => s.id)).toEqual(IDS);
    expect(res.pipeline.map((s) => s.status)).toEqual(['skipped', 'ok', 'ok', 'ok']);
    expect(res.pipeline.map((s) => s.engine)).toEqual(['Not needed', 'Heuristic parser', 'Deterministic 5-rule ranker', 'Templates']);
    const extract = byId(res.pipeline, 'extract');
    expect(extract.chips).toEqual([
      { kind: 'time_window', label: '25 min free' },
      { kind: 'question', label: 'I only have 25 minutes' },
    ]);
    expect(byId(res.pipeline, 'rank').detail).toBe('6 tasks scored · do now: Outline CS 101 assignment');

    const direct = rerank(await agent.post('/plans/rerank').send({ student_id: 'demo', plan_id: res.plan.plan_id, context: { available_minutes: 40 } }));
    expect(byId(direct.pipeline, 'extract')).toMatchObject({ status: 'skipped', detail: 'No question · set directly: 40 min', chips: [] });
  });

  it('preview: same plan and diff as a real rerank, nothing persisted, history unchanged', async () => {
    const agent = request(createApp(mockService()));
    const cap = capture(await agent.post('/captures/text').send({ student_id: 'demo', text: DEMO_TRANSCRIPT }));
    const before = history(await agent.get('/history').query({ student_id: 'demo' }));
    const body = { student_id: 'demo', plan_id: cap.plan.plan_id, context: { question: 'I only have 25 minutes' } };

    const preview = rerank(await agent.post('/plans/rerank').send({ ...body, preview: true }));
    expect(preview.plan.plan_id).toMatch(/^preview-[0-9a-f-]{36}$/);
    expect(preview.previous_plan_id).toBe(cap.plan.plan_id);
    expect(preview.plan.do_now?.task_id).toBe('demo-assignment');
    expect(byId(preview.pipeline, 'rank').detail).toMatch(/^Preview, not saved · /);

    const after = history(await agent.get('/history').query({ student_id: 'demo' }));
    expect(after.entries).toEqual(before.entries);

    // the real rerank from the same plan still diffs against the capture plan (the preview did not become the latest plan)
    const real = rerank(await agent.post('/plans/rerank').send({ ...body, preview: false }));
    expect(real.plan.plan_id).not.toMatch(/^preview-/);
    expect(real.diff).toEqual(preview.diff);
    const strip = (p: Plan): unknown => ({ ...p, plan_id: '', created_at: '' });
    expect(strip(real.plan)).toEqual(strip(preview.plan));
    expect(history(await agent.get('/history').query({ student_id: 'demo' })).entries).toHaveLength(before.entries.length + 1);

    // a preview from the latest plan leaves the stored tasks alone too
    const tasksBefore = capture(await agent.post('/captures/text').send({ student_id: 'demo', text: 'What should I do?' })).tasks;
    await agent.post('/plans/rerank').send({ student_id: 'demo', plan_id: real.plan.plan_id, context: { available_minutes: 5 }, preview: true });
    const tasksAfter = capture(await agent.post('/captures/text').send({ student_id: 'demo', text: 'What should I do?' })).tasks;
    expect(tasksAfter).toEqual(tasksBefore);
  });

  it('a task marked done through POST /actions disappears from the next rerank', async () => {
    const agent = request(createApp(mockService()));
    const cap = capture(await agent.post('/captures/text').send({ student_id: 'demo', text: DEMO_TRANSCRIPT }));
    expect(cap.plan.do_now?.task_id).toBe('demo-return-headphones');
    const done = await agent.post('/actions').send({ student_id: 'demo', plan_id: cap.plan.plan_id, task_id: 'demo-return-headphones', kind: 'done' });
    expect(done.status).toBe(200);

    const res = rerank(await agent.post('/plans/rerank').send({ student_id: 'demo', plan_id: cap.plan.plan_id }));
    expect(items(res.plan).some((i) => i.task_id === 'demo-return-headphones')).toBe(false);
    expect(res.plan.reasoning.pre_rank.some((p) => p.task_id === 'demo-return-headphones')).toBe(false);
    expect(res.plan.do_now?.task_id).not.toBe('demo-return-headphones');
    expect(res.diff.do_now_changed).toBe(true);
  });

  it('an explicit available_minutes replaces the carried 25 minutes (and a capture time_window)', async () => {
    const agent = request(createApp(mockService()));
    const cap = capture(await agent.post('/captures/text').send({ student_id: 'demo', text: DEMO_TRANSCRIPT }));
    const full = cap.plan.reasoning.free_window?.minutes ?? 0;
    expect(full).toBe(47);

    const r25 = rerank(await agent.post('/plans/rerank').send({ student_id: 'demo', plan_id: cap.plan.plan_id, context: { question: 'I only have 25 minutes' } }));
    expect(r25.plan.reasoning.effective_minutes).toBe(25);

    const carried = rerank(await agent.post('/plans/rerank').send({ student_id: 'demo', plan_id: r25.plan.plan_id, context: {} }));
    expect(carried.plan.reasoning.effective_minutes).toBe(25);

    const back = rerank(await agent.post('/plans/rerank').send({ student_id: 'demo', plan_id: carried.plan.plan_id, context: { available_minutes: full } }));
    expect(back.plan.reasoning.effective_minutes).toBe(47);
    expect(back.plan.reasoning.context).toEqual({ available_minutes: 47, cash_available: null, question: null });
    expect(back.plan.do_now?.task_id).toBe('demo-return-headphones');

    const windowCapture = capture(await agent.post('/captures/text').send({ student_id: 'demo', text: 'I only have 25 minutes. What should I do?' }));
    expect(windowCapture.plan.reasoning.effective_minutes).toBe(25);
    const cleared = rerank(await agent.post('/plans/rerank').send({ student_id: 'demo', plan_id: windowCapture.plan.plan_id, context: { available_minutes: full } }));
    expect(cleared.plan.reasoning.effective_minutes).toBe(47);
  });
});

describe('pipeline trace after a live failure', () => {
  function failing(error: Error): Backend {
    const fail = async (): Promise<never> => {
      throw error;
    };
    return {
      health: fail,
      captureText: fail,
      captureVoice: fail,
      rerank: fail,
      timetableToday: fail,
      timetable: fail,
      putTimetable: fail,
      profile: fail,
      putProfile: fail,
      recordAction: fail,
      history: fail,
      pivotLog: fail,
      createPivotLog: fail,
      resetDemo: fail,
      warmPing: fail,
    };
  }

  it('marks every stage that ran as fallback and puts the reason on the first stage', async () => {
    const service = liveServiceWith(failing(new Error('snowflake unreachable')));
    const cap = await service.captureText({ student_id: 'demo', text: DEMO_TRANSCRIPT, followup_plan_id: null });
    expect(cap.source).toBe('fallback');
    expect(cap.pipeline.map((s) => s.status)).toEqual(['fallback', 'fallback', 'fallback', 'fallback']);
    expect(cap.pipeline[0]?.detail).toBe('Snowflake unavailable · 36 words');
    expect(cap.pipeline[1]?.detail).toBe('3 tasks · 2 constraints');
    expect(cap.pipeline[1]?.chips.length).toBe(6);

    const r = await service.rerank({ student_id: 'demo', plan_id: cap.plan.plan_id, context: { question: 'I only have 25 minutes' } });
    expect(r.pipeline.map((s) => s.status)).toEqual(['skipped', 'fallback', 'fallback', 'fallback']);
    expect(r.pipeline[0]?.detail).toBe('Snowflake unavailable · Nothing new to transcribe');

    const timeout = new Error('snowflake rerank timed out after 80 ms');
    timeout.name = 'TimeoutError';
    const slow = liveServiceWith(failing(timeout));
    const t = await slow.captureVoice({ student_id: 'demo', audio: null, followup_plan_id: null, client_transcript: 'I need groceries.' });
    expect(t.transcript).toBe('I need groceries.');
    expect(t.pipeline[0]).toMatchObject({ engine: 'On-device speech (iOS)', status: 'fallback', detail: 'Snowflake timed out · 3 words' });
  });
});

import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app';
import { mockService } from './helpers';
import { createClock } from '../src/clock';

describe('non-demo student isolation', () => {
  it('starts empty and plans only submitted tasks, isolated from demo and other students', async () => {
    const api = request(createApp(mockService()));
    await api.post('/captures/text').send({ student_id: 'demo', text: 'I need to return headphones.' });
    const empty = await api.get('/timetable?student_id=real-a');
    expect(empty.body.blocks).toEqual([]);
    const a = await api.post('/captures/text').send({student_id:'real-a',text:'I need to finish my biology essay tomorrow. I need to call the dentist.'});
    expect(a.status).toBe(200);
    expect(a.body.tasks.length).toBeGreaterThan(0);
    expect(JSON.stringify(a.body)).not.toMatch(/headphones|CHEM 110|CS 101|demo-return|laundry/i);
    const b = await api.post('/captures/text').send({student_id:'real-b',text:'I need to renew my passport.'});
    expect(JSON.stringify(b.body)).not.toMatch(/biology|dentist|headphones|groceries/i);
    const ids = new Set(a.body.tasks.map((t: {task_id: string}) => t.task_id));
    for (const item of [a.body.plan.do_now, ...a.body.plan.today, ...a.body.plan.can_wait].filter(Boolean)) {
      if (item.task_id) expect(ids.has(item.task_id)).toBe(true);
    }
  });
  it('does not pretend untranscribed audio is the demo sentence', async () => {
    const api = request(createApp(mockService()));
    const response = await api.post('/captures/voice').field('student_id','real-voice')
      .attach('audio',Buffer.from('not audio'),{filename:'voice.m4a',contentType:'audio/m4a'});
    expect(response.status).toBe(200);
    expect(response.body.needs_text).toBe(true);
    expect(response.body.transcript).toBe('');
    expect(response.body.tasks).toEqual([]);
    expect(response.body.plan.do_now).toBeNull();
  });
  it('does not manufacture tasks for a question-only capture', async () => {
    const response = await request(createApp(mockService())).post('/captures/text')
      .send({student_id:'real-empty',text:'What should I do?'});
    expect(response.body.tasks).toEqual([]);
    expect(response.body.plan.do_now).toBeNull();
  });
  it('extracts new tasks in follow-ups without losing existing tasks', async () => {
    const api = request(createApp(mockService()));
    const first = await api.post('/captures/text').send({student_id:'real-followup',text:'I need to renew my passport.'});
    const next = await api.post('/captures/text').send({student_id:'real-followup',text:'I need to finish my biology essay tomorrow.',followup_plan_id:first.body.plan.plan_id});
    expect(next.status).toBe(200);
    expect(next.body.previous_plan_id).toBe(first.body.plan.plan_id);
    expect(JSON.stringify(next.body.tasks)).toMatch(/passport/i);
    expect(JSON.stringify(next.body.tasks)).toMatch(/biology/i);
    expect(JSON.stringify(next.body.tasks)).not.toMatch(/headphones|CHEM 110/);
    const history = await api.get('/history?student_id=real-followup');
    expect(history.body.entries).toHaveLength(2);
  });
});



describe('explicit identity and real input', () => {
  for (const route of ['/history', '/profile', '/timetable', '/timetable/today']) {
    it(`rejects missing and blank student IDs on ${route}`, async () => {
      const api = request(createApp(mockService()));
      expect((await api.get(route)).status).toBe(400);
      expect((await api.get(route).query({ student_id: ' ' })).status).toBe(400);
    });
  }

  it('uses the actual voice transcript for a new student', async () => {
    const response = await request(createApp(mockService())).post('/captures/voice')
      .field('student_id', 'voice-person')
      .field('client_transcript', 'I need to renew my passport tomorrow.')
      .attach('audio', Buffer.from('audio handled by device'), { filename: 'voice.m4a', contentType: 'audio/m4a' });
    expect(response.status).toBe(200);
    expect(response.body.needs_text).toBe(false);
    expect(response.body.transcript).toBe('I need to renew my passport tomorrow.');
    expect(response.body.tasks).toHaveLength(1);
    expect(response.body.plan.do_now.title).toMatch(/passport/i);
    expect(JSON.stringify(response.body)).not.toMatch(/headphones|CHEM 110|CS 101/);
  });

  for (const mode of ['mock', 'live'] as const) {
    it(`uses wall-clock time by default in ${mode} mode`, () => {
      const before = Date.now();
      const clock = createClock({ mode, demoNow: null });
      const now = clock.now().getTime();
      expect(clock.pinned).toBe(false);
      expect(now).toBeGreaterThanOrEqual(before);
      expect(now).toBeLessThanOrEqual(Date.now());
    });
  }

  it('only freezes the clock when explicitly requested', () => {
    const clock = createClock({ mode: 'mock', demoNow: '13:13' });
    expect(clock.pinned).toBe(true);
    expect(clock.now().getHours()).toBe(13);
    expect(clock.now().getMinutes()).toBe(13);
  });
});
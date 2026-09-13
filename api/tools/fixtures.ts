// Regenerates the iOS offline fixtures (CONTRACT section 7) by running the API in-process in MOCK_MODE.
// Usage: npm run fixtures
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { createApp } from '../src/app';
import { createClock } from '../src/clock';
import { MemoryBackend } from '../src/backends/memory';
import { PipService } from '../src/service';
import { setLogLevel } from '../src/log';

const OUT_DIR = path.resolve(__dirname, '..', '..', 'ios', 'Pip', 'Pip', 'Resources', 'Offline');

function objectBody(res: request.Response, name: string): Record<string, unknown> {
  if (res.status !== 200) throw new Error(`${name}: HTTP ${res.status} ${res.text}`);
  const body: unknown = res.body;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new Error(`${name}: not a JSON object`);
  if (!('source' in body)) throw new Error(`${name}: missing source`);
  return body as Record<string, unknown>;
}

function field(obj: unknown, key: string): unknown {
  if (typeof obj !== 'object' || obj === null || !(key in obj)) throw new Error(`missing field ${key}`);
  return (obj as Record<string, unknown>)[key];
}

function write(name: string, body: unknown): void {
  const file = path.join(OUT_DIR, name);
  writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
  console.log(`wrote ${path.relative(process.cwd(), file)}`);
}

async function main(): Promise<void> {
  setLogLevel('warn');
  const clock = createClock({ demoNow: null, mode: 'mock' }); // pinned at 13:13 today
  const memory = new MemoryBackend({ clock, snowflakeConfigured: false });
  const app = createApp(new PipService('mock', memory));
  const agent = request(app);
  mkdirSync(OUT_DIR, { recursive: true });

  write('health.json', objectBody(await agent.get('/health'), 'health'));

  const capture = objectBody(
    await agent
      .post('/captures/voice')
      .field('student_id', 'demo')
      .attach('audio', Buffer.from('offline fixture placeholder audio'), { filename: 'capture.m4a', contentType: 'audio/m4a' }),
    'capture_voice',
  );
  write('capture_voice.json', capture);
  const planId = field(field(capture, 'plan'), 'plan_id');
  if (typeof planId !== 'string') throw new Error('capture plan_id missing');

  const rerank = objectBody(
    await agent.post('/plans/rerank').send({ student_id: 'demo', plan_id: planId, context: { question: 'I only have 25 minutes' } }),
    'rerank_25',
  );
  write('rerank_25.json', rerank);

  const rerankPlan = field(rerank, 'plan');
  const rerankPlanId = field(rerankPlan, 'plan_id');
  const doNow = field(rerankPlan, 'do_now');
  const doNowTaskId = doNow === null ? null : field(doNow, 'task_id');
  const action = objectBody(
    await agent.post('/actions').send({ student_id: 'demo', plan_id: rerankPlanId, task_id: doNowTaskId, kind: 'start_now' }),
    'action_start_now',
  );
  write('action_start_now.json', action);

  write('timetable_today.json', objectBody(await agent.get('/timetable/today').query({ student_id: 'demo' }), 'timetable_today'));
  write('timetable_week.json', objectBody(await agent.get('/timetable').query({ student_id: 'demo' }), 'timetable_week'));
  write('profile.json', objectBody(await agent.get('/profile').query({ student_id: 'demo' }), 'profile'));
  write('history.json', objectBody(await agent.get('/history').query({ student_id: 'demo' }), 'history'));
  write('pivot_log.json', objectBody(await agent.get('/pivot-log'), 'pivot_log'));
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});

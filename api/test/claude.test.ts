import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app';
import { addDays, atTime, dateOnly, fixedClock, hhmm, nextFridayAfter } from '../src/clock';
import { loadConfig } from '../src/config';
import { MemoryBackend } from '../src/backends/memory';
import { demoBaseline, DEMO_TASK_IDS, DEMO_TRANSCRIPT } from '../src/demo/scenario';
import { planStructure } from '../src/demo/fixtures';
import { claudeExtract, ClaudeExtractError, OUTPUT_SCHEMA, type ClaudeClient, type ClaudeMessageLike } from '../src/llm/claudeExtract';
import { createTranscriptExtractor, type TranscriptExtractor } from '../src/llm/extractor';
import { heuristicExtract } from '../src/ranker/extract';
import { PipService } from '../src/service';
import type { Plan, PlanItem } from '../src/types';
import { demoNow, mockService } from './helpers';

type CreateBody = Parameters<ClaudeClient['messages']['create']>[0];
type CreateOptions = Parameters<ClaudeClient['messages']['create']>[1];

interface FakeClient {
  client: ClaudeClient;
  calls: Array<{ body: CreateBody; options: CreateOptions }>;
}

function fakeClient(respond: (body: CreateBody) => Promise<ClaudeMessageLike>): FakeClient {
  const calls: FakeClient['calls'] = [];
  return {
    calls,
    client: {
      messages: {
        create(body, options) {
          calls.push({ body, options });
          return respond(body);
        },
      },
    },
  };
}

function textMessage(text: string, stopReason = 'end_turn'): ClaudeMessageLike {
  return { stop_reason: stopReason, content: [{ type: 'text', text }] };
}

const local = (d: Date): string => `${dateOnly(d)}T${hhmm(d)}`;

/** What Claude realistically returns for the demo sentence (it cannot know the $79 or the stored estimates). */
function demoClaudeOutput(now: Date): unknown {
  const empty = { minutes: null, amount: null, until: null, title: null, starts_at: null, ends_at: null, location: null, to: null };
  return {
    tasks: [
      {
        merge_into: DEMO_TASK_IDS.return,
        raw_text: 'I need to return headphones by 5 PM or lose the refund',
        normalized_text: 'Return headphones',
        category: 'errand',
        due_at: local(atTime(now, '17:00')),
        money_at_risk: null,
        est_minutes: null,
      },
      {
        merge_into: DEMO_TASK_IDS.assignment,
        raw_text: 'My assignment is due tomorrow',
        normalized_text: 'Finish assignment',
        category: 'assignment',
        due_at: local(atTime(addDays(now, 1), '23:59')),
        money_at_risk: null,
        // a guessed estimate on a merge must not replace the stored 180 min
        est_minutes: 120,
      },
      { merge_into: DEMO_TASK_IDS.groceries, raw_text: 'I need groceries', normalized_text: 'Buy groceries', category: 'errand', due_at: null, money_at_risk: null, est_minutes: null },
    ],
    constraints: [
      { ...empty, kind: 'fixed_block', title: 'Lab', starts_at: '14:00' },
      { ...empty, kind: 'cash', amount: 35, until: dateOnly(nextFridayAfter(now)) },
    ],
    question: 'What should I do?',
  };
}

const OPTIONS = { model: 'claude-haiku-4-5', timeoutMs: 2000 };

function serviceWith(extractor: TranscriptExtractor): PipService {
  return new PipService('mock', new MemoryBackend({ clock: fixedClock(demoNow()), snowflakeConfigured: false, extractor }));
}

function copyOf(plan: Plan): unknown {
  const pick = (i: PlanItem | null): unknown => (i === null ? null : { item_id: i.item_id, title: i.title, action: i.action, why: i.why, starts_at: i.starts_at, ends_at: i.ends_at });
  return {
    structure: planStructure(plan),
    do_now: pick(plan.do_now),
    next: pick(plan.next),
    today: plan.today.map(pick),
    can_wait: plan.can_wait.map(pick),
    summary: plan.reasoning.summary,
    effective: plan.reasoning.effective_minutes,
    cash: plan.reasoning.cash_available,
    budget_until: plan.reasoning.budget_until,
  };
}

describe('claudeExtract', () => {
  it('maps realistic Claude output for the demo sentence to the same merges and constraints as the heuristic parser', async () => {
    const now = demoNow();
    const open = demoBaseline(now).tasks;
    const fake = fakeClient(async () => textMessage(JSON.stringify(demoClaudeOutput(now))));
    const result = await claudeExtract(DEMO_TRANSCRIPT, now, open, { client: fake.client, ...OPTIONS });
    const heuristic = heuristicExtract(DEMO_TRANSCRIPT, now, open);

    expect(result.tasks.map((t) => t.merge_into)).toEqual([DEMO_TASK_IDS.return, DEMO_TASK_IDS.assignment, DEMO_TASK_IDS.groceries]);
    expect(result.tasks.map((t) => t.due_at)).toEqual(heuristic.tasks.map((t) => t.due_at));
    expect(result.tasks.map((t) => t.est_minutes)).toEqual([null, null, null]);
    expect(result.constraints).toEqual(heuristic.constraints);
    expect(result.question).toBe('What should I do?');

    expect(fake.calls).toHaveLength(1);
    const call = fake.calls[0];
    expect(call?.body.model).toBe('claude-haiku-4-5');
    expect(call?.body.output_config?.format).toEqual({ type: 'json_schema', schema: OUTPUT_SCHEMA });
    const user = call?.body.messages[0]?.content;
    expect(typeof user === 'string' ? user : '').toContain(`today: ${dateOnly(now)}`);
    expect(typeof user === 'string' ? user : '').toContain(`- ${DEMO_TASK_IDS.return} | Return headphones for refund | errand | ${dateOnly(now)} 17:00 | 35 min`);
    expect(call?.options?.maxRetries).toBe(0);
    expect(call?.options?.signal).toBeInstanceOf(AbortSignal);
  });

  it('drops unknown merge ids, fills new-task estimates, validates constraint shapes', async () => {
    const now = demoNow();
    const output = {
      tasks: [
        { merge_into: 'task-that-does-not-exist', raw_text: 'pick up my prescription by 6 PM', normalized_text: 'pick up prescription', category: 'errand', due_at: `${dateOnly(now)}T18:00`, money_at_risk: 0, est_minutes: null },
        { merge_into: null, raw_text: 'take a nap', normalized_text: 'Nap', category: 'rest', due_at: null, money_at_risk: null, est_minutes: null },
      ],
      constraints: [
        { kind: 'time_window', minutes: 25, amount: null, until: null, title: null, starts_at: null, ends_at: null, location: null, to: null },
        { kind: 'travel', minutes: 15, amount: null, until: null, title: null, starts_at: null, ends_at: null, location: null, to: 'campus' },
        { kind: 'fixed_block', minutes: null, amount: null, until: null, title: 'MATH 151', starts_at: '9:30', ends_at: '10:50', location: ' Math Building 210 ', to: null },
      ],
      question: '  ',
    };
    const fake = fakeClient(async () => textMessage(JSON.stringify(output)));
    const r = await claudeExtract('...', now, demoBaseline(now).tasks, { client: fake.client, ...OPTIONS });
    expect(r.tasks[0]).toMatchObject({ merge_into: null, normalized_text: 'Pick up prescription', money_at_risk: null, est_minutes: 30 });
    expect(r.tasks[1]?.est_minutes).toBe(30);
    expect(r.constraints).toEqual([
      { kind: 'time_window', value: { minutes: 25 } },
      { kind: 'travel', value: { minutes: 15, to: 'campus' } },
      { kind: 'fixed_block', value: { title: 'MATH 151', starts_at: '09:30', ends_at: '10:50', location: 'Math Building 210' } },
    ]);
    expect(r.question).toBeNull();
  });

  it('rejects non-JSON, schema-invalid output, refusals and API errors with ClaudeExtractError', async () => {
    const now = demoNow();
    const open = demoBaseline(now).tasks;
    const run = (respond: () => Promise<ClaudeMessageLike>): Promise<unknown> => claudeExtract('x', now, open, { client: fakeClient(respond).client, ...OPTIONS });

    await expect(run(async () => textMessage('Sure! Here are your tasks.'))).rejects.toMatchObject({ reason: 'invalid_output' });
    const badCategory = demoClaudeOutput(now) as { tasks: Array<{ category: string }> };
    const first = badCategory.tasks[0];
    if (first) first.category = 'chores';
    await expect(run(async () => textMessage(JSON.stringify(badCategory)))).rejects.toMatchObject({ reason: 'invalid_output' });
    const badCash = { tasks: [], constraints: [{ kind: 'cash', minutes: null, amount: null, until: 'Friday', title: null, starts_at: null, ends_at: null, location: null, to: null }], question: null };
    await expect(run(async () => textMessage(JSON.stringify(badCash)))).rejects.toMatchObject({ reason: 'invalid_output' });
    await expect(run(async () => textMessage('{"tasks": [', 'max_tokens'))).rejects.toMatchObject({ reason: 'invalid_output' });
    await expect(run(async () => ({ stop_reason: 'refusal', content: [] }))).rejects.toMatchObject({ reason: 'refusal' });
    await expect(run(async () => Promise.reject(new Error('529 overloaded')))).rejects.toBeInstanceOf(ClaudeExtractError);
  });

  it('times out and aborts the request', async () => {
    const now = demoNow();
    const fake = fakeClient(() => new Promise<ClaudeMessageLike>(() => undefined));
    const started = Date.now();
    await expect(claudeExtract('x', now, [], { client: fake.client, model: 'claude-haiku-4-5', timeoutMs: 50 })).rejects.toMatchObject({ reason: 'timeout' });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(fake.calls[0]?.options?.signal?.aborted).toBe(true);
  });
});

describe('Claude in the memory backend', () => {
  it('the demo sentence through Claude merges into the six demo tasks and yields the identical demo plan', async () => {
    const now = demoNow();
    const fake = fakeClient(async () => textMessage(JSON.stringify(demoClaudeOutput(now))));
    const withClaude = await serviceWith(createTranscriptExtractor({ client: fake.client, ...OPTIONS })).captureText({
      student_id: 'demo',
      text: DEMO_TRANSCRIPT,
      followup_plan_id: null,
    });
    const heuristic = await mockService().captureText({ student_id: 'demo', text: DEMO_TRANSCRIPT, followup_plan_id: null });

    const extract = withClaude.pipeline[1];
    expect(extract).toMatchObject({ id: 'extract', engine: 'Claude · claude-haiku-4-5', status: 'ok', detail: '3 tasks · 2 constraints' });
    expect(extract?.chips.map((c) => c.label)).toEqual(heuristic.pipeline[1]?.chips.map((c) => c.label));
    expect(withClaude.tasks).toEqual(heuristic.tasks);
    expect(withClaude.tasks).toHaveLength(6);
    expect(copyOf(withClaude.plan)).toEqual(copyOf(heuristic.plan));
    expect(withClaude.plan.do_now?.title).toBe('Return headphones');
  });

  it('invalid Claude output falls back to the heuristic parser with the reason on the extract stage', async () => {
    const fake = fakeClient(async () => textMessage('not json at all'));
    const res = await serviceWith(createTranscriptExtractor({ client: fake.client, ...OPTIONS })).captureText({
      student_id: 'demo',
      text: DEMO_TRANSCRIPT,
      followup_plan_id: null,
    });
    expect(res.pipeline[1]).toMatchObject({ engine: 'Heuristic parser', status: 'fallback', detail: 'Claude output invalid · 3 tasks · 2 constraints' });
    expect(res.plan.do_now?.task_id).toBe('demo-return-headphones');
    expect(fake.calls).toHaveLength(1);
  });

  it('a Claude timeout falls back to the heuristic parser', async () => {
    const fake = fakeClient(() => new Promise<ClaudeMessageLike>(() => undefined));
    const res = await serviceWith(createTranscriptExtractor({ client: fake.client, model: 'claude-haiku-4-5', timeoutMs: 40 })).captureText({
      student_id: 'demo',
      text: DEMO_TRANSCRIPT,
      followup_plan_id: null,
    });
    expect(res.pipeline[1]).toMatchObject({ engine: 'Heuristic parser', status: 'fallback', detail: 'Claude timed out · 3 tasks · 2 constraints' });
    expect(res.plan.do_now?.task_id).toBe('demo-return-headphones');
  });

  it('follow-ups never call Claude (minutes and cash are parsed from the question)', async () => {
    const fake = fakeClient(async () => textMessage(JSON.stringify(demoClaudeOutput(demoNow()))));
    const service = serviceWith(createTranscriptExtractor({ client: fake.client, ...OPTIONS }));
    const cap = await service.captureText({ student_id: 'demo', text: DEMO_TRANSCRIPT, followup_plan_id: null });
    const follow = await service.captureText({ student_id: 'demo', text: 'I only have 25 minutes', followup_plan_id: cap.plan.plan_id });
    expect(fake.calls).toHaveLength(1);
    expect(follow.plan.do_now?.task_id).toBe('demo-assignment');
  });
});

describe('Claude config and /health', () => {
  it('reads ANTHROPIC_API_KEY, PIP_CLAUDE_MODEL and PIP_CLAUDE_TIMEOUT_MS', () => {
    const off = loadConfig({});
    expect(off.claudeConfigured).toBe(false);
    expect(off.claude).toEqual({ apiKey: null, model: 'claude-haiku-4-5', timeoutMs: 8000 });
    const on = loadConfig({ ANTHROPIC_API_KEY: 'test-key', PIP_CLAUDE_MODEL: 'claude-sonnet-5', PIP_CLAUDE_TIMEOUT_MS: '1500' });
    expect(on.claudeConfigured).toBe(true);
    expect(on.claude).toEqual({ apiKey: 'test-key', model: 'claude-sonnet-5', timeoutMs: 1500 });
    expect(loadConfig({ PIP_CLAUDE_TIMEOUT_MS: 'soon' }).claude.timeoutMs).toBe(8000);
  });

  it('GET /health carries the claude block', async () => {
    const plain = await request(createApp(mockService())).get('/health');
    expect((plain.body as { claude: unknown }).claude).toEqual({ configured: false, model: null });

    const fake = fakeClient(async () => textMessage('{}'));
    const configured = await request(createApp(serviceWith(createTranscriptExtractor({ client: fake.client, ...OPTIONS })))).get('/health');
    expect((configured.body as { claude: unknown }).claude).toEqual({ configured: true, model: 'claude-haiku-4-5' });
    expect(fake.calls).toHaveLength(0);
  });
});

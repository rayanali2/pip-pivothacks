import { existsSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/log', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/log')>();
  return { ...mod, logSql: vi.fn(mod.logSql) };
});

import { logSql } from '../src/log';
import { loadConfig } from '../src/config';
import { fixedClock, isoDow } from '../src/clock';
import { LiveBackend, type LiveBackendOptions } from '../src/backends/live';
import { buildPlan } from '../src/ranker/plan';
import { demoBaseline, DEMO_TRANSCRIPT } from '../src/demo/scenario';
import { putSql, type Bind, type Row, type SqlExecutor } from '../src/snowflake/client';
import { silentWav, verifyCortex } from '../src/snowflake/cortex';
import { normalizePlanFromSnowflake } from '../src/snowflake/rows';
import { RULE_IDS, type Plan, type PlanContext, type PlanItem } from '../src/types';
import { demoNow, liveServiceWith } from './helpers';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface Call {
  sql: string;
  binds: readonly Bind[];
}

type Handler = (sql: string, binds: readonly Bind[]) => Row[] | Promise<Row[]>;

class FakeExecutor implements SqlExecutor {
  readonly calls: Call[] = [];
  private readonly handler: Handler;

  constructor(handler: Handler) {
    this.handler = handler;
  }

  async query(sql: string, binds: readonly Bind[] = []): Promise<Row[]> {
    this.calls.push({ sql, binds });
    return this.handler(sql, binds);
  }

  sqls(): string[] {
    return this.calls.map((c) => c.sql);
  }

  find(prefix: string): Call | undefined {
    return this.calls.find((c) => c.sql.startsWith(prefix));
  }
}

const config = loadConfig({ SNOWFLAKE_ACCOUNT: 'acct', SNOWFLAKE_USER: 'user', SNOWFLAKE_PASSWORD: 'placeholder', SNOWFLAKE_WAREHOUSE: 'wh' });
const ISO_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/;

function live(executor: SqlExecutor, options?: LiveBackendOptions): LiveBackend {
  return new LiveBackend(config, fixedClock(demoNow()), executor, options);
}

/** IsoDateTime -> Snowflake NTZ string (local wall time, no offset). */
const ntz = (iso: string | null): string | null => (iso === null ? null : iso.slice(0, 19));

function taskRows(now: Date): Row[] {
  return demoBaseline(now).tasks.map((t) => ({
    TASK_ID: t.task_id,
    STUDENT_ID: t.student_id,
    CAPTURE_ID: t.capture_id,
    RAW_TEXT: t.raw_text,
    NORMALIZED_TEXT: t.normalized_text,
    CATEGORY: t.category,
    DUE_AT: ntz(t.due_at),
    MONEY_AT_RISK: t.money_at_risk,
    EST_MINUTES: t.est_minutes,
    STATUS: t.status,
    DEFER_COUNT: t.defer_count,
    CREATED_AT: ntz(t.created_at),
  }));
}

function timetableRows(now: Date): Row[] {
  return demoBaseline(now).timetable.map((b) => ({
    STUDENT_ID: b.student_id,
    DAY_OF_WEEK: b.day_of_week,
    TITLE: b.title,
    STARTS_AT: b.starts_at,
    ENDS_AT: b.ends_at,
    LOCATION: b.location,
  }));
}

function profileRow(now: Date): Row {
  const p = demoBaseline(now).profile;
  return {
    STUDENT_ID: p.student_id,
    CHRONOTYPE: p.chronotype,
    COOKS_OWN_MEALS: p.cooks_own_meals,
    CASH_AVAILABLE: p.cash_available,
    BUDGET_UNTIL: p.budget_until,
    PROCRASTINATES_ON: p.procrastinates_on,
    UPDATED_AT: ntz(p.updated_at),
  };
}

function rankerPlan(planId: string, captureId: string | null, context: PlanContext, model: string, previous: Plan | null = null): Plan {
  const now = demoNow();
  const base = demoBaseline(now);
  return buildPlan({
    plan_id: planId,
    student_id: 'demo',
    capture_id: captureId,
    created_at: '2026-09-13T20:00:00-07:00',
    now,
    tasks: base.tasks,
    timetable: base.timetable,
    profile: base.profile,
    constraints: [],
    context,
    trigger: previous ? 'rerank' : 'capture',
    previous_plan: previous,
    model,
  });
}

/** What BUILD_PLAN returns: NTZ datetimes, empty evidence/curve, plus cortex_errors. */
function asSnowflakeVariant(plan: Plan, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const item = (i: PlanItem | null): Record<string, unknown> | null =>
    i === null ? null : { ...i, starts_at: ntz(i.starts_at), ends_at: ntz(i.ends_at), due_at: ntz(i.due_at), evidence: [], curve: [] };
  const fw = plan.reasoning.free_window;
  return {
    ...plan,
    created_at: ntz(plan.created_at),
    do_now: item(plan.do_now),
    next: item(plan.next),
    today: plan.today.map(item),
    can_wait: plan.can_wait.map(item),
    reasoning: {
      ...plan.reasoning,
      now: ntz(plan.reasoning.now),
      free_window: fw ? { ...fw, starts_at: ntz(fw.starts_at), ends_at: ntz(fw.ends_at), next_block_starts_at: ntz(fw.next_block_starts_at) } : null,
    },
    ...extra,
  };
}

function planItems(plan: Plan): PlanItem[] {
  return [plan.do_now, plan.next, ...plan.today, ...plan.can_wait].filter((i): i is PlanItem => i !== null);
}

const EMPTY_CONTEXT: PlanContext = { available_minutes: null, cash_available: null, question: null };

beforeEach(() => {
  vi.mocked(logSql).mockClear();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('LiveBackend', () => {
  it('(a) every Snowflake call throws -> UniMateService answers 200-shaped data with source fallback', async () => {
    const executor = new FakeExecutor(() => {
      throw new Error('snowflake unreachable');
    });
    const service = liveServiceWith(live(executor));

    const capture = await service.captureText({ student_id: 'demo', text: DEMO_TRANSCRIPT, followup_plan_id: null });
    expect(capture.source).toBe('fallback');
    expect(capture.plan.do_now?.task_id).toBe('demo-return-headphones');

    const rerank = await service.rerank({ student_id: 'demo', plan_id: capture.plan.plan_id, context: { question: 'I only have 25 minutes' } });
    expect(rerank.source).toBe('fallback');
    expect(rerank.plan.do_now?.task_id).toBe('demo-assignment');

    const history = await service.history('demo');
    expect(history.source).toBe('fallback');
    expect(history.entries.length).toBeGreaterThan(0);

    const action = await service.recordAction({ student_id: 'demo', plan_id: rerank.plan.plan_id, task_id: 'demo-assignment', kind: 'start_now' });
    expect(action.source).toBe('fallback');
    expect(action.action.kind).toBe('start_now');

    const voice = await service.captureVoice({
      student_id: 'demo',
      audio: { buffer: Buffer.from('x'), originalname: 'capture.m4a', mimetype: 'audio/m4a' },
      followup_plan_id: null,
    });
    expect(voice.source).toBe('fallback');

    const health = await service.health(false);
    expect(health.mode).toBe('live');
    expect(health.source).toBe('fallback');
    expect(health.snowflake.connected).toBe(false);
    expect(health.snowflake.error).toContain('snowflake unreachable');
    expect(executor.calls.length).toBeGreaterThan(0);
  });

  it.each([
    { enabled: true, text: 'I need to tidy my desk.', fast: true },
    { enabled: true, text: DEMO_TRANSCRIPT, fast: true },
    { enabled: false, text: DEMO_TRANSCRIPT, fast: false },
    { enabled: true, text: 'Can I afford lunch?', fast: false },
  ])('capture fast=$fast with enabled=$enabled preserves extraction, tasks and ranking', async ({ enabled, text, fast }) => {
    const executor = new FakeExecutor((sql, binds) => {
      if (sql.startsWith('CALL PIP.APP.EXTRACT_FROM_TRANSCRIPT')) {
        return [{ EXTRACT_FROM_TRANSCRIPT: { tasks: [{ task_id: 'demo-return-headphones' }], constraints: [], model: 'test', attempts: 1 } }];
      }
      if (sql.startsWith('CALL PIP.APP.BUILD_PLAN')) {
        return [{ BUILD_PLAN: asSnowflakeVariant(rankerPlan('test-plan', String(binds[1]), EMPTY_CONTEXT, 'sql-prerank')) }];
      }
      if (sql.startsWith('SELECT') && sql.includes('FROM PIP.APP.TASKS')) return taskRows(demoNow());
      return [];
    });
    const backend = new LiveBackend({ ...config, fastCapturePlan: enabled }, fixedClock(demoNow()), executor);
    const result = await backend.captureText({ student_id: 'demo', text, followup_plan_id: null });
    const extra = JSON.parse(String(executor.find('CALL PIP.APP.BUILD_PLAN')?.binds[2]));
    expect(extra.skip_llm === true).toBe(fast);
    expect(executor.find('CALL PIP.APP.EXTRACT_FROM_TRANSCRIPT')).toBeDefined();
    expect(result.source).toBe('snowflake');
    expect(result.tasks).toHaveLength(6);
    expect(result.plan.do_now?.task_id).toBe('demo-return-headphones');
  });

  it('(b)+(d) BUILD_PLAN VARIANT -> source snowflake, offsets, 5 evidence entries, no cortex_errors; every SQL logged via logSql', async () => {
    const now = demoNow();
    const executor = new FakeExecutor((sql, binds) => {
      if (sql.startsWith('CALL PIP.APP.EXTRACT_FROM_TRANSCRIPT')) {
        return [{ EXTRACT_FROM_TRANSCRIPT: { tasks: [{ task_id: 'demo-return-headphones' }], constraints: [], model: 'claude-sonnet-4-5', attempts: 1 } }];
      }
      if (sql.startsWith('CALL PIP.APP.BUILD_PLAN')) {
        const plan = rankerPlan('sf-plan-1', String(binds[1]), EMPTY_CONTEXT, 'claude-sonnet-4-5');
        return [{ BUILD_PLAN: asSnowflakeVariant(plan, { cortex_errors: ['AI_COMPLETE/claude-sonnet-4-5: unknown model'] }) }];
      }
      if (sql.startsWith('SELECT') && sql.includes('FROM PIP.APP.TASKS')) return taskRows(now);
      return [];
    });
    const res = await live(executor).captureText({ student_id: 'demo', text: DEMO_TRANSCRIPT, followup_plan_id: null });

    expect(res.source).toBe('snowflake');
    expect(res.needs_text).toBe(false);
    expect(res.plan.model).toBe('claude-sonnet-4-5');
    expect(res.plan.do_now?.task_id).toBe('demo-return-headphones');
    expect(res.tasks).toHaveLength(6);
    expect(res.capture.capture_id).toBe(res.plan.capture_id);

    expect(res.plan.created_at).toMatch(ISO_OFFSET);
    expect(res.plan.reasoning.now).toMatch(ISO_OFFSET);
    expect(res.plan.reasoning.free_window?.starts_at).toMatch(ISO_OFFSET);
    expect(res.plan.reasoning.free_window?.next_block_starts_at).toMatch(ISO_OFFSET);
    for (const item of planItems(res.plan)) {
      for (const v of [item.starts_at, item.ends_at, item.due_at]) if (v !== null) expect(v).toMatch(ISO_OFFSET);
      if (item.kind === 'task') {
        expect(item.evidence.map((e) => e.rule)).toEqual([...RULE_IDS]);
        expect(item.curve.length).toBeGreaterThan(0);
      } else {
        expect(item.evidence).toEqual([]);
      }
    }
    expect(Object.keys(res.plan)).not.toContain('cortex_errors');
    expect(JSON.stringify(res)).not.toContain('cortex_errors');

    const buildCall = executor.find('CALL PIP.APP.BUILD_PLAN');
    expect(buildCall?.sql).toBe('CALL PIP.APP.BUILD_PLAN(?, ?, PARSE_JSON(?))');
    const extra: unknown = JSON.parse(String(buildCall?.binds[2]));
    expect(extra).toEqual({ now_local: ntz(`${res.plan.reasoning.now}`), trigger: 'capture', skip_llm: true });
    expect(executor.find('INSERT INTO PIP.APP.CAPTURES')?.binds.slice(0, 5)).toEqual([res.capture.capture_id, 'demo', null, DEMO_TRANSCRIPT, 'text']);
    expect(executor.find('INSERT INTO PIP.APP.PLANS')).toBeUndefined();

    // (d) logSql saw exactly the statements the executor ran, in order, with their binds
    const logged = vi.mocked(logSql).mock.calls.map((c) => c[0]);
    expect(executor.calls.length).toBeGreaterThan(3);
    expect(logged).toEqual(executor.sqls());
    expect(vi.mocked(logSql).mock.calls.map((c) => c[1] ?? [])).toEqual(executor.calls.map((c) => c.binds));
  });

  it('(c) BUILD_PLAN returns {error} -> TypeScript ranker plan stored in PLANS, source fallback', async () => {
    const now = demoNow();
    const executor = new FakeExecutor((sql) => {
      if (sql.startsWith('CALL PIP.APP.EXTRACT_FROM_TRANSCRIPT')) {
        return [{ EXTRACT_FROM_TRANSCRIPT: { tasks: [], constraints: [], model: null, attempts: 2, error: 'LLM extraction failed: no Cortex' } }];
      }
      if (sql.startsWith('CALL PIP.APP.BUILD_PLAN')) return [{ BUILD_PLAN: { error: 'boom: Cortex unavailable' } }];
      if (sql.startsWith('SELECT') && sql.includes('FROM PIP.APP.TASKS')) return taskRows(now);
      if (sql.startsWith('SELECT') && sql.includes('FROM PIP.APP.TIMETABLE')) return timetableRows(now);
      if (sql.startsWith('SELECT') && sql.includes('FROM PIP.APP.PROFILE')) return [profileRow(now)];
      return [];
    });
    const res = await live(executor).captureText({ student_id: 'demo', text: DEMO_TRANSCRIPT, followup_plan_id: null });

    expect(res.source).toBe('fallback');
    expect(res.plan.model).toBe('deterministic-ranker-v1');
    expect(res.plan.do_now?.task_id).toBe('demo-return-headphones');
    expect(res.plan.next?.item_id).toBe(`block:${isoDow(now)}:14:00`);
    expect(res.plan.reasoning.free_window?.label).toBe('47 min free until CHEM 110 Lab, 2:00 PM');
    expect(res.plan.do_now?.evidence).toHaveLength(5);

    // heuristic extraction wrote to Snowflake (3 merges + 2 constraints + cash on the profile)
    expect(executor.sqls().filter((s) => s.startsWith('UPDATE PIP.APP.TASKS SET due_at'))).toHaveLength(3);
    expect(executor.sqls().filter((s) => s.startsWith('INSERT INTO PIP.APP.CONSTRAINTS'))).toHaveLength(2);
    const insert = executor.find('INSERT INTO PIP.APP.PLANS');
    expect(insert?.binds[0]).toBe(res.plan.plan_id);
    expect(insert?.binds[8]).toBe('deterministic-ranker-v1');
    expect(String(insert?.binds[9])).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
    expect(vi.mocked(logSql).mock.calls.map((c) => c[0])).toEqual(executor.sqls());
  });

  it('rerank through BUILD_PLAN: merged context, diff against the stored plan', async () => {
    const now = demoNow();
    const previous = rankerPlan('sf-plan-base', 'cap-1', EMPTY_CONTEXT, 'claude-sonnet-4-5');
    const executor = new FakeExecutor((sql, binds) => {
      if (sql.startsWith('SELECT') && sql.includes('FROM PIP.APP.PLANS WHERE plan_id = ?')) {
        const v = asSnowflakeVariant(previous);
        return [
          {
            PLAN_ID: v.plan_id,
            STUDENT_ID: v.student_id,
            CAPTURE_ID: v.capture_id,
            MODEL: v.model,
            CREATED_AT: v.created_at,
            DO_NOW: v.do_now,
            NEXT: v.next,
            TODAY: JSON.stringify(v.today),
            CAN_WAIT: v.can_wait,
            REASONING: v.reasoning,
          },
        ];
      }
      if (sql.startsWith('CALL PIP.APP.BUILD_PLAN')) {
        const extra = JSON.parse(String(binds[2])) as { available_minutes: number | null; question: string | null };
        const next = rankerPlan('sf-plan-25', 'cap-1', { available_minutes: extra.available_minutes, cash_available: null, question: extra.question }, 'mistral-large2', previous);
        return [{ BUILD_PLAN: JSON.stringify(asSnowflakeVariant(next)) }];
      }
      if (sql.startsWith('SELECT') && sql.includes('FROM PIP.APP.TASKS')) return taskRows(now);
      return [];
    });
    const res = await live(executor).rerank({ student_id: 'demo', plan_id: 'sf-plan-base', context: { question: 'I only have 25 minutes' } });

    expect(res.source).toBe('snowflake');
    expect(res.previous_plan_id).toBe('sf-plan-base');
    expect(res.plan.do_now?.task_id).toBe('demo-assignment');
    expect(res.diff.do_now_changed).toBe(true);
    expect(res.diff.previous_do_now_title).toBe(previous.do_now?.title);
    const extra: unknown = JSON.parse(String(executor.find('CALL PIP.APP.BUILD_PLAN')?.binds[2]));
    expect(extra).toMatchObject({ trigger: 'rerank', previous_plan_id: 'sf-plan-base', available_minutes: 25, cash_available: null, question: 'I only have 25 minutes' });
    expect(executor.find('CALL PIP.APP.BUILD_PLAN')?.binds[1]).toBe('cap-1');
  });

  it('voice: transcription fails for .m4a and .mp4 -> needs_text with the staged path and the latest plan', async () => {
    const now = demoNow();
    const stored = asSnowflakeVariant(rankerPlan('sf-plan-latest', null, EMPTY_CONTEXT, 'sql-prerank'));
    const putFiles: string[] = [];
    const executor = new FakeExecutor((sql) => {
      if (sql.startsWith("PUT 'file://")) {
        const file = /^PUT 'file:\/\/([^']+)'/.exec(sql)?.[1] ?? '';
        expect(existsSync(file)).toBe(true);
        putFiles.push(file);
        return [{ source: 'capture.m4a', target: 'capture.m4a', status: 'UPLOADED' }];
      }
      if (sql.startsWith('SELECT AI_TRANSCRIBE')) throw new Error('Unsupported audio format');
      if (sql.startsWith('SELECT') && sql.includes('FROM PIP.APP.PLANS WHERE student_id = ?')) {
        return [{ PLAN_ID: stored.plan_id, STUDENT_ID: 'demo', CAPTURE_ID: null, MODEL: 'sql-prerank', CREATED_AT: stored.created_at, DO_NOW: stored.do_now, NEXT: stored.next, TODAY: stored.today, CAN_WAIT: stored.can_wait, REASONING: stored.reasoning }];
      }
      if (sql.startsWith('SELECT') && sql.includes('FROM PIP.APP.TASKS')) return taskRows(now);
      return [];
    });
    const res = await live(executor).captureVoice({
      student_id: 'demo',
      audio: { buffer: Buffer.from('not really audio'), originalname: 'capture.m4a', mimetype: 'audio/m4a' },
      followup_plan_id: null,
    });

    expect(res.needs_text).toBe(true);
    expect(res.transcript).toBe('');
    expect(res.capture.source).toBe('text');
    expect(res.capture.audio_stage_path).toMatch(/^demo\/\d{4}-\d{2}-\d{2}\/capture-[0-9a-f-]+\.m4a$/);
    expect(putFiles.map((f) => f.slice(-4))).toEqual(['.m4a', '.mp4']);
    expect(putFiles.every((f) => !existsSync(f))).toBe(true);
    expect(executor.sqls().filter((s) => s.startsWith('SELECT AI_TRANSCRIBE'))).toHaveLength(2);
    expect(executor.find('INSERT INTO PIP.APP.CAPTURES')?.binds.slice(2, 5)).toEqual([res.capture.audio_stage_path, '', 'text']);
    expect(res.plan.plan_id).toBe('sf-plan-latest');
    expect(res.plan.do_now?.evidence).toHaveLength(5);
  });

  it('(e) an executor that never resolves -> falls back within the injected timeout', async () => {
    const hanging: SqlExecutor = { query: () => new Promise<Row[]>(() => undefined) };
    const service = liveServiceWith(live(hanging, { timeouts: { captureMs: 80, defaultMs: 80, healthMs: 80 } }));

    const started = Date.now();
    const capture = await service.captureText({ student_id: 'demo', text: DEMO_TRANSCRIPT, followup_plan_id: null });
    expect(capture.source).toBe('fallback');
    const history = await service.history('demo');
    expect(history.source).toBe('fallback');
    const health = await service.health(false);
    expect(health.snowflake.connected).toBe(false);
    expect(health.snowflake.error).toContain('timed out');
    expect(Date.now() - started).toBeLessThan(3000);
  });
});

describe('Snowflake helpers', () => {
  it('normalizePlanFromSnowflake accepts a JSON-string VARIANT and rejects a wrong shape', () => {
    const plan = rankerPlan('p1', null, EMPTY_CONTEXT, 'sql-prerank');
    const parsed = normalizePlanFromSnowflake(JSON.stringify(asSnowflakeVariant(plan, { cortex_errors: ['x'] })));
    expect(parsed.reasoning.now).toBe(plan.reasoning.now);
    expect(parsed.do_now?.due_at).toBe(plan.do_now?.due_at);
    expect(Object.keys(parsed)).not.toContain('cortex_errors');
    expect(() => normalizePlanFromSnowflake({ plan_id: 'p', today: 'nope' })).toThrow(/invalid plan/);
  });

  it('putSql quotes a forward-slash file URI (Windows paths included)', () => {
    expect(putSql('C:\\Users\\shaan\\AppData\\Local\\Temp\\pip-capture-x\\capture-1.m4a', 'demo/2026-09-13')).toBe(
      "PUT 'file://C:/Users/shaan/AppData/Local/Temp/pip-capture-x/capture-1.m4a' @PIP.APP.AUDIO_STAGE/demo/2026-09-13/ AUTO_COMPRESS = FALSE OVERWRITE = TRUE",
    );
    expect(putSql('/tmp/probe.wav', '_probe')).toBe("PUT 'file:///tmp/probe.wav' @PIP.APP.AUDIO_STAGE/_probe/ AUTO_COMPRESS = FALSE OVERWRITE = TRUE");
    expect(() => putSql('/tmp/x.m4a', '../etc')).toThrow();
  });

  it('silentWav is a 1 s 16 kHz mono PCM file', () => {
    const wav = silentWav();
    expect(wav.length).toBe(44 + 32_000);
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.readUInt32LE(24)).toBe(16_000);
    expect(wav.readUInt16LE(22)).toBe(1);
  });

  it('verifyCortex walks the chains, stages a probe WAV and MERGEs CORTEX_CONFIG', async () => {
    const executor = new FakeExecutor((sql) => {
      if (sql.startsWith("SELECT AI_COMPLETE('claude-sonnet-4-5'")) throw new Error('Unknown model claude-sonnet-4-5\nmore detail');
      if (sql.startsWith('SELECT AI_EMBED')) throw new Error('Unknown function AI_EMBED');
      if (sql.startsWith("PUT 'file://")) {
        const file = /^PUT 'file:\/\/([^']+)'/.exec(sql)?.[1] ?? '';
        expect(existsSync(file)).toBe(true);
        return [{ status: 'UPLOADED' }];
      }
      if (sql.startsWith('SELECT AI_TRANSCRIBE')) return [{ RESULT: { text: '' } }];
      return [{ OK: 1 }];
    });
    const status = await verifyCortex(executor);
    expect(status).toMatchObject({ complete: 'AI_COMPLETE', complete_model: 'mistral-large2', embed: 'SNOWFLAKE.CORTEX.EMBED_TEXT_768', transcribe: 'AI_TRANSCRIBE', errors: [] });
    expect(status.verified_at).toMatch(ISO_OFFSET);
    expect(executor.find("SELECT AI_COMPLETE('mistral-large2', ?)")?.binds).toEqual(['Reply with the single word OK.']);
    expect(executor.find('SELECT AI_TRANSCRIBE')?.sql).toBe("SELECT AI_TRANSCRIBE(TO_FILE('@PIP.APP.AUDIO_STAGE', '_probe/probe.wav')) AS RESULT");
    expect(executor.find('MERGE INTO PIP.APP.CORTEX_CONFIG')?.binds).toEqual([
      'complete_fn',
      'AI_COMPLETE',
      'complete_model',
      'mistral-large2',
      'embed_fn',
      'SNOWFLAKE.CORTEX.EMBED_TEXT_768',
      'transcribe_fn',
      'AI_TRANSCRIBE',
    ]);
    expect(vi.mocked(logSql).mock.calls.map((c) => c[0])).toEqual(executor.sqls());
  });

  it('verifyCortex never throws', async () => {
    const status = await verifyCortex(
      new FakeExecutor(() => {
        throw new Error('connect ETIMEDOUT');
      }),
    );
    expect(status).toMatchObject({ complete: null, embed: null, transcribe: null, verified_at: null });
    expect(status.errors[0]).toContain('ETIMEDOUT');
  });
});

import { describe, expect, it } from 'vitest';
import type { Backend } from '../src/backends/backend';
import { loadConfig } from '../src/config';
import { LiveBackend } from '../src/backends/live';
import { liveServiceWith } from './helpers';

function throwingBackend(): Backend {
  const fail = async (): Promise<never> => {
    throw new Error('snowflake unreachable');
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

describe('PipService fallback', () => {
  it('answers from memory with source fallback when every live call throws', async () => {
    const service = liveServiceWith(throwingBackend());

    const capture = await service.captureVoice({ student_id: 'demo', audio: null, followup_plan_id: null });
    expect(capture.source).toBe('fallback');
    expect(capture.plan.do_now?.task_id).toBe('demo-return-headphones');

    const rerank = await service.rerank({ student_id: 'demo', plan_id: capture.plan.plan_id, context: { available_minutes: 25 } });
    expect(rerank.source).toBe('fallback');
    expect(rerank.plan.do_now?.task_id).toBe('demo-assignment');

    const health = await service.health(true);
    expect(health.source).toBe('fallback');
    expect(health.mode).toBe('live');
    expect(health.snowflake.connected).toBe(false);
    expect(health.snowflake.error).toBe('snowflake unreachable');

    expect((await service.history('demo')).source).toBe('fallback');
    expect((await service.pivotLog()).source).toBe('fallback');
    expect((await service.warmPing()).source).toBe('fallback');
  });

  it('a LiveBackend whose Snowflake calls fail falls back too', async () => {
    const config = loadConfig({
      SNOWFLAKE_ACCOUNT: 'acct',
      SNOWFLAKE_USER: 'user',
      SNOWFLAKE_PASSWORD: 'placeholder',
      SNOWFLAKE_WAREHOUSE: 'wh',
    });
    expect(config.mode).toBe('live');
    // Inject a failing executor: the real client would attempt a network login to acct.snowflakecomputing.com.
    const unreachable = {
      query: async (): Promise<never> => {
        throw new Error('snowflake unreachable');
      },
    };
    const service = liveServiceWith(new LiveBackend(config, undefined, unreachable));
    const capture = await service.captureText({ student_id: 'demo', text: 'I have a 2 PM lab. What should I do?', followup_plan_id: null });
    expect(capture.source).toBe('fallback');
  });

  it('config: mock when MOCK_MODE=true or Snowflake is not configured', () => {
    expect(loadConfig({}).mode).toBe('mock');
    expect(loadConfig({}).port).toBe(3000);
    expect(loadConfig({ MOCK_MODE: 'true', SNOWFLAKE_ACCOUNT: 'a', SNOWFLAKE_USER: 'u', SNOWFLAKE_PASSWORD: 'p', SNOWFLAKE_WAREHOUSE: 'w' }).mode).toBe('mock');
    expect(loadConfig({ DEMO_NOW: '9:05' }).demoNow).toBe('09:05');
    expect(loadConfig({ DEMO_NOW: 'real' }).demoNow).toBe('real');
    expect(loadConfig({}).snowflake.database).toBe('PIP');
  });

  it('config: accepts a PAT without a password and rejects blank credentials', () => {
    const env = { SNOWFLAKE_ACCOUNT: 'a', SNOWFLAKE_USER: 'u', SNOWFLAKE_WAREHOUSE: 'w' };
    expect(loadConfig({ ...env, SNOWFLAKE_TOKEN: 'test-token' }).mode).toBe('live');
    expect(loadConfig({ ...env, SNOWFLAKE_TOKEN: '  ' }).mode).toBe('mock');
    expect(loadConfig({ ...env, SNOWFLAKE_TOKEN: 'test-token', MOCK_MODE: 'true' }).mode).toBe('mock');
  });
});

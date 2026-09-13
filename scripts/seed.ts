// Demo baseline for Snowflake. Run from api/:  npm run seed
// Loads api/.env, connects with the API's SnowflakeClient (session TIMEZONE = PIP_TIMEZONE) and upserts the CONTRACT
// section 5 baseline anchored to the scenario clock (DEMO_NOW if set, otherwise today 13:13), then stores the seeded
// Today Plan (TypeScript ranker, trigger 'seed') and verifies Cortex. Safe to re-run: every write is a MERGE or a
// DELETE + INSERT of the same demo rows.
import { getConfig } from '../api/src/config';
import { createClock, toIsoLocal } from '../api/src/clock';
import { errorMessage } from '../api/src/log';
import { SnowflakeClient, type Bind } from '../api/src/snowflake/client';
import { describeCortex, verifyCortex } from '../api/src/snowflake/cortex';
import { isoToNtz, PipRepo, TS_FMT } from '../api/src/snowflake/repo';
import { demoBaseline, DEMO_SEED_CAPTURE_ID, DEMO_STUDENT_ID, DEMO_TRANSCRIPT } from '../api/src/demo/scenario';
import { applyDemoCopy } from '../api/src/demo/fixtures';
import { buildPlan, RANKER_MODEL } from '../api/src/ranker/plan';
import { DEFAULT_DECAY_CONFIG } from '../api/src/ranker/decay';
import type { Plan } from '../api/src/types';

const SEED_PLAN_ID = 'demo-plan-seed';

function unionSelect(first: string, rest: string, count: number): string {
  return [first, ...Array.from({ length: Math.max(0, count - 1) }, () => rest)].join('\nUNION ALL ');
}

function ntzOrThrow(iso: string): string {
  const v = isoToNtz(iso);
  if (v === null) throw new Error(`invalid datetime ${iso}`);
  return v;
}

function planLine(plan: Plan): string {
  const today = plan.today.map((i) => i.title).join(', ');
  const canWait = plan.can_wait.map((i) => i.title).join(', ');
  return [
    `  free window: ${plan.reasoning.free_window?.label ?? 'none'}`,
    `  do now:      ${plan.do_now?.title ?? 'nothing'}`,
    `  next:        ${plan.next?.title ?? 'nothing'}`,
    `  today:       ${today || '-'}`,
    `  can wait:    ${canWait || '-'}`,
  ].join('\n');
}

async function main(): Promise<number> {
  const config = getConfig();
  if (!config.snowflakeConfigured) {
    console.error(
      'Snowflake is not configured. Set SNOWFLAKE_ACCOUNT, SNOWFLAKE_USER, SNOWFLAKE_PASSWORD and SNOWFLAKE_WAREHOUSE in api/.env (see api/.env.example), then run "npm run seed" again.',
    );
    return 1;
  }

  const clock = createClock({ demoNow: config.demoNow ?? '13:13', mode: 'live' });
  const now = clock.now();
  const realIso = toIsoLocal(clock.realNow());
  const base = demoBaseline(now, DEMO_STUDENT_ID);
  const client = new SnowflakeClient({ settings: config.snowflake, timezone: config.timezone });
  const repo = new PipRepo(client);
  const step = (label: string): void => console.log(`- ${label}`);

  try {
    console.log(`Seeding Snowflake demo baseline for "${DEMO_STUDENT_ID}" at scenario time ${toIsoLocal(now)} (session TIMEZONE ${config.timezone})`);
    await client.query('SELECT 1 AS OK');

    step('DECAY_CONFIG');
    {
      const binds: Bind[] = [];
      for (const d of DEFAULT_DECAY_CONFIG) binds.push(d.category, d.curve, d.half_life_hours, d.floor_weight);
      await client.query(
        `MERGE INTO PIP.APP.DECAY_CONFIG t
USING (${unionSelect('SELECT ? AS category, ? AS curve, ? AS half_life_hours, ? AS floor_weight', 'SELECT ?, ?, ?, ?', DEFAULT_DECAY_CONFIG.length)}) s
ON t.category = s.category
WHEN MATCHED THEN UPDATE SET curve = s.curve, half_life_hours = s.half_life_hours, floor_weight = s.floor_weight
WHEN NOT MATCHED THEN INSERT (category, curve, half_life_hours, floor_weight) VALUES (s.category, s.curve, s.half_life_hours, s.floor_weight)`,
        binds,
      );
    }

    step('STUDENTS');
    await client.query(
      `MERGE INTO PIP.APP.STUDENTS t
USING (SELECT ? AS student_id, TO_TIMESTAMP_NTZ(?, ${TS_FMT}) AS created_at) s
ON t.student_id = s.student_id
WHEN NOT MATCHED THEN INSERT (student_id, created_at) VALUES (s.student_id, s.created_at)`,
      [DEMO_STUDENT_ID, ntzOrThrow(base.student.created_at)],
    );

    step(`TIMETABLE (${base.timetable.length} blocks, CHEM 110 Lab on today's weekday)`);
    await repo.replaceTimetable(DEMO_STUDENT_ID, base.timetable);

    step('PROFILE');
    await repo.mergeProfile(base.profile);

    step(`CAPTURES (${DEMO_SEED_CAPTURE_ID})`);
    await client.query('DELETE FROM PIP.APP.CONSTRAINTS WHERE capture_id = ?', [DEMO_SEED_CAPTURE_ID]);
    await client.query('DELETE FROM PIP.APP.CAPTURES WHERE capture_id = ?', [DEMO_SEED_CAPTURE_ID]);
    await repo.insertCapture({
      capture_id: DEMO_SEED_CAPTURE_ID,
      student_id: DEMO_STUDENT_ID,
      audio_stage_path: null,
      transcript: DEMO_TRANSCRIPT,
      source: 'text',
      created_at: realIso,
    });

    step(`TASKS (${base.tasks.length} open demo tasks)`);
    {
      const binds: Bind[] = [];
      for (const t of base.tasks) {
        binds.push(
          t.task_id,
          t.student_id,
          t.capture_id,
          t.raw_text,
          t.normalized_text,
          t.category,
          isoToNtz(t.due_at),
          t.money_at_risk,
          t.est_minutes,
          t.defer_count,
          ntzOrThrow(t.created_at),
        );
      }
      const first = `SELECT ? AS task_id, ? AS student_id, ? AS capture_id, ? AS raw_text, ? AS normalized_text, ? AS category,
  TRY_TO_TIMESTAMP_NTZ(?, ${TS_FMT}) AS due_at, ?::NUMBER(10,2) AS money_at_risk, ?::NUMBER(6,0) AS est_minutes,
  ?::NUMBER(6,0) AS defer_count, TO_TIMESTAMP_NTZ(?, ${TS_FMT}) AS created_at`;
      const rest = `SELECT ?, ?, ?, ?, ?, ?, TRY_TO_TIMESTAMP_NTZ(?, ${TS_FMT}), ?::NUMBER(10,2), ?::NUMBER(6,0), ?::NUMBER(6,0), TO_TIMESTAMP_NTZ(?, ${TS_FMT})`;
      await client.query(
        `MERGE INTO PIP.APP.TASKS t
USING (${unionSelect(first, rest, base.tasks.length)}) s
ON t.task_id = s.task_id
WHEN MATCHED THEN UPDATE SET student_id = s.student_id, capture_id = s.capture_id, raw_text = s.raw_text,
  normalized_text = s.normalized_text, category = s.category, due_at = s.due_at, money_at_risk = s.money_at_risk,
  est_minutes = s.est_minutes, status = 'open', defer_count = s.defer_count, created_at = s.created_at
WHEN NOT MATCHED THEN INSERT (task_id, student_id, capture_id, raw_text, normalized_text, category, due_at, money_at_risk,
  est_minutes, status, defer_count, created_at)
  VALUES (s.task_id, s.student_id, s.capture_id, s.raw_text, s.normalized_text, s.category, s.due_at, s.money_at_risk,
  s.est_minutes, 'open', s.defer_count, s.created_at)`,
        binds,
      );
    }

    step('other open demo-student tasks -> dropped');
    await client.query(
      "UPDATE PIP.APP.TASKS SET status = 'dropped' WHERE student_id = ? AND task_id NOT LIKE 'demo-%' AND status IN ('open', 'deferred')",
      [DEMO_STUDENT_ID],
    );

    step('PIVOT_LOG (pivots 1-2)');
    {
      const binds: Bind[] = [];
      for (const p of base.pivot_log) {
        binds.push(p.entry_id, p.pivot_number, p.revealed, p.assumption_changed, p.response, p.cut, p.sentence, ntzOrThrow(p.created_at));
      }
      const first = `SELECT ? AS entry_id, ? AS pivot_number, ? AS revealed, ? AS assumption_changed, ? AS response, ? AS cut,
  ? AS sentence, TO_TIMESTAMP_NTZ(?, ${TS_FMT}) AS created_at`;
      const rest = `SELECT ?, ?, ?, ?, ?, ?, ?, TO_TIMESTAMP_NTZ(?, ${TS_FMT})`;
      await client.query(
        `MERGE INTO PIP.APP.PIVOT_LOG t
USING (${unionSelect(first, rest, base.pivot_log.length)}) s
ON t.pivot_number = s.pivot_number
WHEN MATCHED THEN UPDATE SET revealed = s.revealed, assumption_changed = s.assumption_changed, response = s.response,
  cut = s.cut, sentence = s.sentence
WHEN NOT MATCHED THEN INSERT (entry_id, pivot_number, revealed, assumption_changed, response, cut, sentence, created_at)
  VALUES (s.entry_id, s.pivot_number, s.revealed, s.assumption_changed, s.response, s.cut, s.sentence, s.created_at)`,
        binds,
      );
    }

    step(`PLANS (seeded Today Plan ${SEED_PLAN_ID}, ${RANKER_MODEL})`);
    const raw = buildPlan({
      plan_id: SEED_PLAN_ID,
      student_id: DEMO_STUDENT_ID,
      capture_id: DEMO_SEED_CAPTURE_ID,
      created_at: realIso,
      now,
      tasks: base.tasks,
      timetable: base.timetable,
      profile: base.profile,
      constraints: [],
      context: { available_minutes: null, cash_available: null, question: null },
      trigger: 'seed',
      previous_plan: null,
      decay: DEFAULT_DECAY_CONFIG,
      model: RANKER_MODEL,
    });
    const plan = applyDemoCopy(raw, base.tasks, { pinned: clock.pinned, now });
    await client.query('DELETE FROM PIP.APP.PLANS WHERE plan_id = ?', [SEED_PLAN_ID]);
    await repo.insertPlan(plan);
    console.log(planLine(plan));

    step('Cortex verification (AI_COMPLETE / AI_EMBED / AI_TRANSCRIBE -> CORTEX_CONFIG)');
    const cortex = await verifyCortex(client, { now: () => clock.realNow() });
    console.log(`  ${describeCortex(cortex)}`);
    console.log(JSON.stringify(cortex, null, 2));
    console.log('Seed complete.');
    return 0;
  } finally {
    await client.close();
  }
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(`Seed failed: ${errorMessage(err)}`);
    process.exit(1);
  },
);

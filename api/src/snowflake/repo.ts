import type {
  Capture,
  Constraint,
  DecayConfig,
  HistoryAction,
  HistoryEntry,
  JsonValue,
  PivotLogEntry,
  Plan,
  Profile,
  Task,
  TimetableBlock,
} from '../types';
import { ACTION_KINDS, CATEGORIES, CHRONOTYPES, CONSTRAINT_KINDS, DECAY_CURVES, TASK_STATUSES } from '../types';
import { toNtzLocal, tryParseIsoLocal } from '../clock';
import { errorMessage, log } from '../log';
import { AUDIO_STAGE, isConnectionError, type Bind, type SqlExecutor } from './client';
import {
  asRecord,
  bool,
  cell,
  json,
  normalizePlanFromSnowflake,
  ntz,
  ntzOrNull,
  num,
  numOrNull,
  oneOf,
  parseContext,
  parseVariant,
  str,
  strOrNull,
  toJsonValue,
  type Row,
} from './rows';

export const TS_FMT = `'YYYY-MM-DD"T"HH24:MI:SS'`;

/** IsoDateTime (any offset) -> local NTZ 'YYYY-MM-DDTHH:MM:SS' for binds. */
export function isoToNtz(iso: string | null): string | null {
  if (iso === null) return null;
  const d = tryParseIsoLocal(iso);
  return d ? toNtzLocal(d) : null;
}

function requireNtz(iso: string): string {
  const v = isoToNtz(iso);
  if (v === null) throw new Error(`invalid datetime: ${iso}`);
  return v;
}

const TASK_COLUMNS = `task_id AS TASK_ID, student_id AS STUDENT_ID, capture_id AS CAPTURE_ID, raw_text AS RAW_TEXT,
  normalized_text AS NORMALIZED_TEXT, category AS CATEGORY, TO_VARCHAR(due_at, ${TS_FMT}) AS DUE_AT,
  money_at_risk::FLOAT AS MONEY_AT_RISK, est_minutes AS EST_MINUTES, status AS STATUS, defer_count AS DEFER_COUNT,
  TO_VARCHAR(created_at, ${TS_FMT}) AS CREATED_AT`;

const TIMETABLE_COLUMNS = `student_id AS STUDENT_ID, day_of_week AS DAY_OF_WEEK, title AS TITLE,
  TO_VARCHAR(starts_at, 'HH24:MI') AS STARTS_AT, TO_VARCHAR(ends_at, 'HH24:MI') AS ENDS_AT, location AS LOCATION`;

const PLAN_COLUMNS = `plan_id AS PLAN_ID, student_id AS STUDENT_ID, capture_id AS CAPTURE_ID, model AS MODEL,
  TO_VARCHAR(created_at, ${TS_FMT}) AS CREATED_AT, do_now AS DO_NOW, next AS NEXT, today AS TODAY, can_wait AS CAN_WAIT,
  reasoning AS REASONING`;

/** Every statement the live path issues (binds as ?). */
export const SQL = {
  ping: 'SELECT 1 AS OK',
  openTasks: `SELECT ${TASK_COLUMNS} FROM PIP.APP.TASKS WHERE student_id = ? AND status IN ('open', 'deferred') ORDER BY created_at, task_id`,
  taskById: `SELECT ${TASK_COLUMNS} FROM PIP.APP.TASKS WHERE task_id = ? AND student_id = ?`,
  timetableWeek: `SELECT ${TIMETABLE_COLUMNS} FROM PIP.APP.TIMETABLE WHERE student_id = ? ORDER BY day_of_week, starts_at`,
  timetableDay: `SELECT ${TIMETABLE_COLUMNS} FROM PIP.APP.TIMETABLE WHERE student_id = ? AND day_of_week = ? ORDER BY starts_at`,
  timetableDelete: 'DELETE FROM PIP.APP.TIMETABLE WHERE student_id = ?',
  timetableInsertHead: 'INSERT INTO PIP.APP.TIMETABLE (student_id, day_of_week, title, starts_at, ends_at, location)',
  timetableInsertRow: "SELECT ?, ?, ?, TO_TIME(?, 'HH24:MI'), TO_TIME(?, 'HH24:MI'), ?",
  profile: `SELECT student_id AS STUDENT_ID, chronotype AS CHRONOTYPE, cooks_own_meals AS COOKS_OWN_MEALS,
  cash_available::FLOAT AS CASH_AVAILABLE, TO_VARCHAR(budget_until, 'YYYY-MM-DD') AS BUDGET_UNTIL,
  procrastinates_on AS PROCRASTINATES_ON, TO_VARCHAR(updated_at, ${TS_FMT}) AS UPDATED_AT
FROM PIP.APP.PROFILE WHERE student_id = ?`,
  profileMerge: `MERGE INTO PIP.APP.PROFILE t
USING (SELECT ? AS student_id, ? AS chronotype, ?::BOOLEAN AS cooks_own_meals, ?::NUMBER(10,2) AS cash_available,
              TRY_TO_DATE(?, 'YYYY-MM-DD') AS budget_until, ? AS procrastinates_on, TO_TIMESTAMP_NTZ(?, ${TS_FMT}) AS updated_at) s
ON t.student_id = s.student_id
WHEN MATCHED THEN UPDATE SET chronotype = s.chronotype, cooks_own_meals = s.cooks_own_meals, cash_available = s.cash_available,
  budget_until = s.budget_until, procrastinates_on = s.procrastinates_on, updated_at = s.updated_at
WHEN NOT MATCHED THEN INSERT (student_id, chronotype, cooks_own_meals, cash_available, budget_until, procrastinates_on, updated_at)
  VALUES (s.student_id, s.chronotype, s.cooks_own_meals, s.cash_available, s.budget_until, s.procrastinates_on, s.updated_at)`,
  profileApplyCash: `UPDATE PIP.APP.PROFILE SET cash_available = ?::NUMBER(10,2), budget_until = COALESCE(TRY_TO_DATE(?, 'YYYY-MM-DD'), budget_until),
  updated_at = TO_TIMESTAMP_NTZ(?, ${TS_FMT}) WHERE student_id = ?`,
  decay: 'SELECT category AS CATEGORY, curve AS CURVE, half_life_hours::FLOAT AS HALF_LIFE_HOURS, floor_weight::FLOAT AS FLOOR_WEIGHT FROM PIP.APP.DECAY_CONFIG',
  constraints: `SELECT constraint_id AS CONSTRAINT_ID, capture_id AS CAPTURE_ID, kind AS KIND, value AS VALUE,
  TO_VARCHAR(created_at, ${TS_FMT}) AS CREATED_AT FROM PIP.APP.CONSTRAINTS WHERE capture_id = ? ORDER BY created_at`,
  constraintInsert: `INSERT INTO PIP.APP.CONSTRAINTS (constraint_id, capture_id, kind, value, created_at)
SELECT ?, ?, ?, PARSE_JSON(?), TO_TIMESTAMP_NTZ(?, ${TS_FMT})`,
  constraintCopy: `INSERT INTO PIP.APP.CONSTRAINTS (constraint_id, capture_id, kind, value, created_at)
SELECT UUID_STRING(), ?, kind, value, created_at FROM PIP.APP.CONSTRAINTS WHERE capture_id = ?`,
  captureInsert: `INSERT INTO PIP.APP.CAPTURES (capture_id, student_id, audio_stage_path, transcript, source, created_at)
SELECT ?, ?, ?, ?, ?, TO_TIMESTAMP_NTZ(?, ${TS_FMT})`,
  taskInsert: `INSERT INTO PIP.APP.TASKS (task_id, student_id, capture_id, raw_text, normalized_text, category, due_at, money_at_risk,
  est_minutes, status, defer_count, created_at)
SELECT ?, ?, ?, ?, ?, ?, TRY_TO_TIMESTAMP_NTZ(?, ${TS_FMT}), ?::NUMBER(10,2), ?::NUMBER(6,0), ?, ?::NUMBER(6,0), TO_TIMESTAMP_NTZ(?, ${TS_FMT})`,
  taskMerge: `UPDATE PIP.APP.TASKS SET due_at = COALESCE(TRY_TO_TIMESTAMP_NTZ(?, ${TS_FMT}), due_at),
  money_at_risk = COALESCE(?::NUMBER(10,2), money_at_risk), est_minutes = COALESCE(?::NUMBER(6,0), est_minutes),
  capture_id = ?, status = 'open'
WHERE task_id = ? AND student_id = ?`,
  tasksExpire: `UPDATE PIP.APP.TASKS SET status = 'expired'
WHERE student_id = ? AND status IN ('open', 'deferred') AND due_at IS NOT NULL AND due_at <= TO_TIMESTAMP_NTZ(?, ${TS_FMT})`,
  planInsert: `INSERT INTO PIP.APP.PLANS (plan_id, student_id, capture_id, do_now, next, today, can_wait, reasoning, model, created_at)
SELECT ?, ?, ?, PARSE_JSON(?), PARSE_JSON(?), PARSE_JSON(?), PARSE_JSON(?), PARSE_JSON(?), ?, TO_TIMESTAMP_NTZ(?, ${TS_FMT})`,
  planById: `SELECT ${PLAN_COLUMNS} FROM PIP.APP.PLANS WHERE plan_id = ? AND student_id = ?`,
  planLatest: `SELECT ${PLAN_COLUMNS} FROM PIP.APP.PLANS WHERE student_id = ? ORDER BY created_at DESC, plan_id DESC LIMIT 1`,
  callExtract: 'CALL PIP.APP.EXTRACT_FROM_TRANSCRIPT(?)',
  callBuildPlanParseJson: 'CALL PIP.APP.BUILD_PLAN(?, ?, PARSE_JSON(?))',
  callBuildPlanString: 'CALL PIP.APP.BUILD_PLAN(?, ?, ?)',
  callRecordAction: 'CALL PIP.APP.RECORD_ACTION(?, ?, ?, ?)',
  transcribe: `SELECT AI_TRANSCRIBE(TO_FILE('${AUDIO_STAGE}', ?)) AS RESULT`,
  history: `SELECT plan_id AS PLAN_ID, capture_id AS CAPTURE_ID, TO_VARCHAR(created_at, ${TS_FMT}) AS CREATED_AT, model AS MODEL,
  "TRIGGER" AS PLAN_TRIGGER, transcript AS TRANSCRIPT, context AS CONTEXT, do_now_task_id AS DO_NOW_TASK_ID,
  do_now_title AS DO_NOW_TITLE, previous_do_now_title AS PREVIOUS_DO_NOW_TITLE, changed AS CHANGED
FROM PIP.APP.V_PLAN_HISTORY WHERE student_id = ? ORDER BY created_at DESC LIMIT 50`,
  historyActionsHead: `SELECT a.action_id AS ACTION_ID, a.student_id AS STUDENT_ID, a.plan_id AS PLAN_ID, a.task_id AS TASK_ID, a.kind AS KIND,
  TO_VARCHAR(a.created_at, ${TS_FMT}) AS CREATED_AT, t.normalized_text AS TASK_TITLE
FROM PIP.APP.ACTIONS a LEFT JOIN PIP.APP.TASKS t ON t.task_id = a.task_id
WHERE a.student_id = ? AND a.plan_id IN`,
  pivotLog: `SELECT entry_id AS ENTRY_ID, pivot_number AS PIVOT_NUMBER, revealed AS REVEALED, assumption_changed AS ASSUMPTION_CHANGED,
  response AS RESPONSE, cut AS CUT, sentence AS SENTENCE, TO_VARCHAR(created_at, ${TS_FMT}) AS CREATED_AT
FROM PIP.APP.PIVOT_LOG ORDER BY pivot_number, created_at`,
  pivotInsert: `INSERT INTO PIP.APP.PIVOT_LOG (entry_id, pivot_number, revealed, assumption_changed, response, cut, sentence, created_at)
SELECT ?, ?, ?, ?, ?, ?, ?, TO_TIMESTAMP_NTZ(?, ${TS_FMT})`,
} as const;

// ---------------------------------------------------------------------------
// Row mappers
// ---------------------------------------------------------------------------

export function rowToTask(row: Row): Task {
  const est = numOrNull(row, 'EST_MINUTES');
  return {
    task_id: str(row, 'TASK_ID'),
    student_id: str(row, 'STUDENT_ID'),
    capture_id: strOrNull(row, 'CAPTURE_ID'),
    raw_text: strOrNull(row, 'RAW_TEXT') ?? '',
    normalized_text: strOrNull(row, 'NORMALIZED_TEXT') ?? '',
    category: oneOf(CATEGORIES, strOrNull(row, 'CATEGORY'), 'errand'),
    due_at: ntzOrNull(row, 'DUE_AT'),
    money_at_risk: numOrNull(row, 'MONEY_AT_RISK'),
    est_minutes: est === null ? null : Math.round(est),
    status: oneOf(TASK_STATUSES, strOrNull(row, 'STATUS'), 'open'),
    defer_count: Math.round(numOrNull(row, 'DEFER_COUNT') ?? 0),
    created_at: ntz(row, 'CREATED_AT'),
  };
}

export function rowToBlock(row: Row): TimetableBlock {
  return {
    student_id: str(row, 'STUDENT_ID'),
    day_of_week: Math.round(num(row, 'DAY_OF_WEEK')),
    title: str(row, 'TITLE'),
    starts_at: str(row, 'STARTS_AT'),
    ends_at: str(row, 'ENDS_AT'),
    location: strOrNull(row, 'LOCATION'),
  };
}

export function rowToProfile(row: Row): Profile {
  const procrastinates = strOrNull(row, 'PROCRASTINATES_ON');
  return {
    student_id: str(row, 'STUDENT_ID'),
    chronotype: oneOf(CHRONOTYPES, strOrNull(row, 'CHRONOTYPE'), 'neutral'),
    cooks_own_meals: cell(row, 'COOKS_OWN_MEALS') === null ? true : bool(row, 'COOKS_OWN_MEALS'),
    cash_available: numOrNull(row, 'CASH_AVAILABLE') ?? 0,
    budget_until: strOrNull(row, 'BUDGET_UNTIL'),
    procrastinates_on: procrastinates === null ? null : oneOf(CATEGORIES, procrastinates, 'assignment'),
    updated_at: ntz(row, 'UPDATED_AT'),
  };
}

function rowToPivot(row: Row): PivotLogEntry {
  return {
    entry_id: str(row, 'ENTRY_ID'),
    pivot_number: Math.round(num(row, 'PIVOT_NUMBER')),
    revealed: str(row, 'REVEALED'),
    assumption_changed: str(row, 'ASSUMPTION_CHANGED'),
    response: str(row, 'RESPONSE'),
    cut: strOrNull(row, 'CUT') ?? '',
    sentence: strOrNull(row, 'SENTENCE'),
    created_at: ntz(row, 'CREATED_AT'),
  };
}

export function rowToPlan(row: Row): Plan {
  return normalizePlanFromSnowflake({
    plan_id: str(row, 'PLAN_ID'),
    student_id: str(row, 'STUDENT_ID'),
    capture_id: strOrNull(row, 'CAPTURE_ID'),
    created_at: str(row, 'CREATED_AT'),
    model: str(row, 'MODEL'),
    do_now: json(row, 'DO_NOW'),
    next: json(row, 'NEXT'),
    today: json(row, 'TODAY'),
    can_wait: json(row, 'CAN_WAIT'),
    reasoning: json(row, 'REASONING'),
  });
}

/** The Task fields of a touched task the pipeline trace shows as a chip. */
export interface ExtractedTaskSummary {
  normalized_text: string;
  money_at_risk: number | null;
  /** as returned (NTZ 'YYYY-MM-DDTHH:MM:SS' or IsoDateTime) */
  due_at: string | null;
}

export interface ExtractSummary {
  taskCount: number;
  constraintCount: number;
  model: string | null;
  error: string | null;
  /** tasks the procedure inserted or merged (readable ones only) */
  tasks: ExtractedTaskSummary[];
  constraints: Array<Pick<Constraint, 'kind' | 'value'>>;
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return null;
}

/** EXTRACT_FROM_TRANSCRIPT output summary. */
export function readExtractResult(raw: unknown): ExtractSummary {
  const o = asRecord(parseVariant(raw));
  if (!o) return { taskCount: 0, constraintCount: 0, model: null, error: 'EXTRACT_FROM_TRANSCRIPT returned no object', tasks: [], constraints: [] };
  const error = o.error === undefined || o.error === null || o.error === '' ? null : String(o.error);
  const tasks: ExtractedTaskSummary[] = [];
  for (const item of Array.isArray(o.tasks) ? o.tasks : []) {
    const t = asRecord(parseVariant(item));
    if (!t) continue;
    const title = typeof t.normalized_text === 'string' && t.normalized_text.trim() !== '' ? t.normalized_text : typeof t.raw_text === 'string' ? t.raw_text : '';
    tasks.push({ normalized_text: title, money_at_risk: numberOrNull(t.money_at_risk), due_at: typeof t.due_at === 'string' ? t.due_at : null });
  }
  const constraints: Array<Pick<Constraint, 'kind' | 'value'>> = [];
  for (const item of Array.isArray(o.constraints) ? o.constraints : []) {
    const c = asRecord(parseVariant(item));
    const kind = c && typeof c.kind === 'string' ? c.kind : null;
    if (!c || kind === null || !CONSTRAINT_KINDS.some((k) => k === kind)) continue;
    constraints.push({ kind: oneOf(CONSTRAINT_KINDS, kind, 'time_window'), value: toJsonValue(parseVariant(c.value)) });
  }
  return {
    taskCount: Array.isArray(o.tasks) ? o.tasks.length : 0,
    constraintCount: Array.isArray(o.constraints) ? o.constraints.length : 0,
    model: typeof o.model === 'string' ? o.model : null,
    error,
    tasks,
    constraints,
  };
}

export type BuildPlanBindForm = 'parse_json' | 'string';

/** SQL access for the live backend and the seed script. Every method issues parameterized statements only. */
export class UniMateRepo {
  private readonly db: SqlExecutor;
  /** CALL BUILD_PLAN(?, ?, PARSE_JSON(?)) first; switches to a plain JSON-string bind if the account rejects it */
  buildPlanForm: BuildPlanBindForm = 'parse_json';

  constructor(db: SqlExecutor) {
    this.db = db;
  }

  query(sql: string, binds?: readonly Bind[]): Promise<Row[]> {
    return this.db.query(sql, binds);
  }

  async ping(): Promise<void> {
    await this.db.query(SQL.ping);
  }

  async openTasks(studentId: string): Promise<Task[]> {
    return (await this.db.query(SQL.openTasks, [studentId])).map(rowToTask);
  }

  async task(studentId: string, taskId: string): Promise<Task | null> {
    const row = (await this.db.query(SQL.taskById, [taskId, studentId]))[0];
    return row ? rowToTask(row) : null;
  }

  async timetable(studentId: string): Promise<TimetableBlock[]> {
    return (await this.db.query(SQL.timetableWeek, [studentId])).map(rowToBlock);
  }

  async timetableForDay(studentId: string, dow: number): Promise<TimetableBlock[]> {
    return (await this.db.query(SQL.timetableDay, [studentId, dow])).map(rowToBlock);
  }

  /** DELETE the week, then one INSERT ... SELECT ... UNION ALL SELECT ... per 50 blocks. */
  async replaceTimetable(studentId: string, blocks: ReadonlyArray<Omit<TimetableBlock, 'student_id'>>): Promise<void> {
    await this.db.query(SQL.timetableDelete, [studentId]);
    for (let i = 0; i < blocks.length; i += 50) {
      const chunk = blocks.slice(i, i + 50);
      const sql = `${SQL.timetableInsertHead}\n${chunk.map(() => SQL.timetableInsertRow).join('\nUNION ALL ')}`;
      const binds: Bind[] = [];
      for (const b of chunk) binds.push(studentId, b.day_of_week, b.title, b.starts_at, b.ends_at, b.location ?? null);
      await this.db.query(sql, binds);
    }
  }

  async profile(studentId: string): Promise<Profile | null> {
    const row = (await this.db.query(SQL.profile, [studentId]))[0];
    return row ? rowToProfile(row) : null;
  }

  async mergeProfile(profile: Profile): Promise<void> {
    await this.db.query(SQL.profileMerge, [
      profile.student_id,
      profile.chronotype,
      profile.cooks_own_meals,
      profile.cash_available,
      profile.budget_until,
      profile.procrastinates_on,
      requireNtz(profile.updated_at),
    ]);
  }

  async applyCash(studentId: string, amount: number, until: string | null, updatedAt: string): Promise<void> {
    await this.db.query(SQL.profileApplyCash, [amount, until, requireNtz(updatedAt), studentId]);
  }

  async decay(): Promise<DecayConfig[]> {
    const out: DecayConfig[] = [];
    for (const row of await this.db.query(SQL.decay)) {
      const category = strOrNull(row, 'CATEGORY');
      if (category === null || !CATEGORIES.some((c) => c === category)) continue;
      out.push({
        category: oneOf(CATEGORIES, category, 'errand'),
        curve: oneOf(DECAY_CURVES, strOrNull(row, 'CURVE'), 'linear'),
        half_life_hours: num(row, 'HALF_LIFE_HOURS'),
        floor_weight: num(row, 'FLOOR_WEIGHT'),
      });
    }
    return out;
  }

  async constraints(captureId: string): Promise<Constraint[]> {
    const out: Constraint[] = [];
    for (const row of await this.db.query(SQL.constraints, [captureId])) {
      const kind = strOrNull(row, 'KIND');
      if (kind === null || !CONSTRAINT_KINDS.some((k) => k === kind)) continue;
      out.push({
        constraint_id: str(row, 'CONSTRAINT_ID'),
        capture_id: str(row, 'CAPTURE_ID'),
        kind: oneOf(CONSTRAINT_KINDS, kind, 'time_window'),
        value: toJsonValue(json(row, 'VALUE')),
        created_at: ntz(row, 'CREATED_AT'),
      });
    }
    return out;
  }

  async insertConstraint(c: Constraint): Promise<void> {
    await this.db.query(SQL.constraintInsert, [c.constraint_id, c.capture_id, c.kind, JSON.stringify(c.value), requireNtz(c.created_at)]);
  }

  async copyConstraints(fromCaptureId: string, toCaptureId: string): Promise<void> {
    await this.db.query(SQL.constraintCopy, [toCaptureId, fromCaptureId]);
  }

  async insertCapture(c: Capture): Promise<void> {
    await this.db.query(SQL.captureInsert, [c.capture_id, c.student_id, c.audio_stage_path, c.transcript, c.source, requireNtz(c.created_at)]);
  }

  async insertTask(t: Task): Promise<void> {
    await this.db.query(SQL.taskInsert, [
      t.task_id,
      t.student_id,
      t.capture_id,
      t.raw_text,
      t.normalized_text,
      t.category,
      isoToNtz(t.due_at),
      t.money_at_risk,
      t.est_minutes,
      t.status,
      t.defer_count,
      requireNtz(t.created_at),
    ]);
  }

  async mergeTask(
    studentId: string,
    taskId: string,
    captureId: string,
    patch: { due_at: string | null; money_at_risk: number | null; est_minutes: number | null },
  ): Promise<void> {
    await this.db.query(SQL.taskMerge, [isoToNtz(patch.due_at), patch.money_at_risk, patch.est_minutes, captureId, taskId, studentId]);
  }

  async expireTasks(studentId: string, nowNtz: string): Promise<void> {
    await this.db.query(SQL.tasksExpire, [studentId, nowNtz]);
  }

  async insertPlan(plan: Plan): Promise<void> {
    await this.db.query(SQL.planInsert, [
      plan.plan_id,
      plan.student_id,
      plan.capture_id,
      JSON.stringify(plan.do_now),
      JSON.stringify(plan.next),
      JSON.stringify(plan.today),
      JSON.stringify(plan.can_wait),
      JSON.stringify(plan.reasoning),
      plan.model,
      requireNtz(plan.created_at),
    ]);
  }

  async plan(studentId: string, planId: string): Promise<Plan | null> {
    const row = (await this.db.query(SQL.planById, [planId, studentId]))[0];
    return row ? rowToPlan(row) : null;
  }

  async latestPlan(studentId: string): Promise<Plan | null> {
    const row = (await this.db.query(SQL.planLatest, [studentId]))[0];
    return row ? rowToPlan(row) : null;
  }

  private async call(name: string, sql: string, binds: readonly Bind[]): Promise<unknown> {
    const row = (await this.db.query(sql, binds))[0];
    if (!row) return null;
    const direct = cell(row, name);
    return parseVariant(direct !== undefined ? direct : Object.values(row)[0]);
  }

  callExtract(captureId: string): Promise<unknown> {
    return this.call('EXTRACT_FROM_TRANSCRIPT', SQL.callExtract, [captureId]);
  }

  /** CALL BUILD_PLAN with EXTRA_CONTEXT as PARSE_JSON(?) (NOTES recommended form); on a non-connection error retry once with the JSON string bound directly. */
  async callBuildPlan(studentId: string, captureId: string | null, extra: { [key: string]: JsonValue }): Promise<unknown> {
    const binds: Bind[] = [studentId, captureId, JSON.stringify(extra)];
    if (this.buildPlanForm === 'string') return this.call('BUILD_PLAN', SQL.callBuildPlanString, binds);
    try {
      return await this.call('BUILD_PLAN', SQL.callBuildPlanParseJson, binds);
    } catch (err) {
      if (isConnectionError(err)) throw err;
      log.warn(`CALL BUILD_PLAN(?, ?, PARSE_JSON(?)) failed (${errorMessage(err)}); retrying with the JSON string bound directly`);
      const result = await this.call('BUILD_PLAN', SQL.callBuildPlanString, binds);
      this.buildPlanForm = 'string';
      return result;
    }
  }

  callRecordAction(studentId: string, planId: string, taskId: string | null, kind: string): Promise<unknown> {
    return this.call('RECORD_ACTION', SQL.callRecordAction, [studentId, planId, taskId, kind]);
  }

  /** AI_TRANSCRIBE on a staged file (path relative to @PIP.APP.AUDIO_STAGE). Returns the text ('' when silent). */
  async transcribe(stagePath: string): Promise<string> {
    const row = (await this.db.query(SQL.transcribe, [stagePath]))[0];
    const value = row ? parseVariant(cell(row, 'RESULT')) : null;
    if (typeof value === 'string') return value;
    const o = asRecord(value);
    if (o && typeof o.text === 'string') return o.text;
    throw new Error('AI_TRANSCRIBE returned no text');
  }

  async historyEntries(studentId: string): Promise<HistoryEntry[]> {
    const rows = await this.db.query(SQL.history, [studentId]);
    return rows.map((row) => {
      const trigger = oneOf(['capture', 'rerank', 'seed'] as const, strOrNull(row, 'PLAN_TRIGGER'), 'capture');
      const context = parseContext(json(row, 'CONTEXT'));
      const captureTranscript = strOrNull(row, 'TRANSCRIPT');
      let transcript: string | null = null;
      if (trigger === 'rerank') transcript = context?.question ?? captureTranscript;
      else if (trigger === 'capture') transcript = captureTranscript;
      return {
        plan_id: str(row, 'PLAN_ID'),
        capture_id: strOrNull(row, 'CAPTURE_ID'),
        created_at: ntz(row, 'CREATED_AT'),
        model: strOrNull(row, 'MODEL') ?? '',
        trigger,
        transcript,
        context,
        do_now_task_id: strOrNull(row, 'DO_NOW_TASK_ID'),
        do_now_title: strOrNull(row, 'DO_NOW_TITLE'),
        previous_do_now_title: strOrNull(row, 'PREVIOUS_DO_NOW_TITLE'),
        changed: strOrNull(row, 'CHANGED') ?? '',
        actions: [],
      };
    });
  }

  /** Actions for the given plans, newest first. */
  async historyActions(studentId: string, planIds: readonly string[]): Promise<HistoryAction[]> {
    if (planIds.length === 0) return [];
    const sql = `${SQL.historyActionsHead} (${planIds.map(() => '?').join(', ')}) ORDER BY a.created_at DESC`;
    const rows = await this.db.query(sql, [studentId, ...planIds]);
    return rows.map((row) => ({
      action_id: str(row, 'ACTION_ID'),
      student_id: str(row, 'STUDENT_ID'),
      plan_id: str(row, 'PLAN_ID'),
      task_id: strOrNull(row, 'TASK_ID'),
      kind: oneOf(ACTION_KINDS, strOrNull(row, 'KIND'), 'start_now'),
      created_at: ntz(row, 'CREATED_AT'),
      task_title: strOrNull(row, 'TASK_TITLE'),
    }));
  }

  async pivotLog(): Promise<PivotLogEntry[]> {
    return (await this.db.query(SQL.pivotLog)).map(rowToPivot);
  }

  async insertPivot(e: PivotLogEntry): Promise<void> {
    await this.db.query(SQL.pivotInsert, [
      e.entry_id,
      e.pivot_number,
      e.revealed,
      e.assumption_changed,
      e.response,
      e.cut,
      e.sentence,
      requireNtz(e.created_at),
    ]);
  }
}

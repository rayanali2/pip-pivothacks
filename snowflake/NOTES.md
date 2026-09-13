# Snowflake layer: notes for the API

Database `PIP`, schema `APP`, warehouse `PIP_WH`, stage `@PIP.APP.AUDIO_STAGE`.
Setup order: `01_schema.sql`, `02_stage.sql`, `03_functions.sql`, `04_views.sql`, `05_seed.sql` (optional `06_smoke_test.sql`, then re-run `05`).
`03_functions.sql` is generated. Edit `snowflake/src/*`, then run `node snowflake/build.mjs`. The build also syntax-checks the JavaScript procedure bodies.

## 1. Session setup (every connection)

```sql
ALTER SESSION SET TIMEZONE = '<PIP_TIMEZONE, e.g. America/Los_Angeles>';
USE WAREHOUSE PIP_WH;
USE SCHEMA PIP.APP;
```

Every timestamp column is `TIMESTAMP_NTZ` and holds local wall time. The procedures use `CURRENT_TIMESTAMP()::TIMESTAMP_NTZ` for record timestamps, so the session time zone matters. They are `EXECUTE AS CALLER`, so they see the caller's session parameters and Cortex privileges.

## 2. Procedures

All three return a single VARIANT column named after the procedure (`EXTRACT_FROM_TRANSCRIPT`, `BUILD_PLAN`, `RECORD_ACTION`). With snowflake-sdk the value normally arrives as a parsed object. Be defensive: `typeof v === 'string' ? JSON.parse(v) : v`.

Errors never throw. The procedure returns an object with an `error` key instead. Treat `error` as a failure and use the TypeScript fallback.

### EXTRACT_FROM_TRANSCRIPT(CAPTURE_ID VARCHAR) RETURNS VARIANT

```js
conn.execute({ sqlText: 'CALL PIP.APP.EXTRACT_FROM_TRANSCRIPT(?)', binds: [captureId] })
```

Insert the CAPTURES row first (section 5). The procedure reads the transcript, the student's open tasks and the profile, then calls Cortex. The response is parsed, and the call is retried once if parsing fails.

Merge rules, in order:
1. A valid `existing_task_id` from the LLM updates that task.
2. Otherwise, a task with the same category and `JAROWINKLER_SIMILARITY(LOWER(normalized_text)) >= 80` is updated.
3. Otherwise a new task is inserted.

An update fills `due_at` and `money_at_risk` only when the new value is non-null. `est_minutes` is filled only when the task has no estimate yet (the stored estimate wins, as in the TypeScript extractor, so an LLM guess cannot change the demo's 35-min return). It also sets `capture_id` and `status='open'`. Constraints are inserted. A `cash` constraint also MERGEs `PROFILE.cash_available` and `budget_until`.

Returns:
```json
{ "tasks": [Task, ...],               // only the tasks touched by this capture, contract Task shape
  "constraints": [Constraint, ...],   // contract Constraint shape, value already validated
  "model": "claude-sonnet-4-5",
  "attempts": 1 }
```
Failure: `{ "tasks": [], "constraints": [], "model": null, "attempts": 2, "error": "LLM extraction failed: ..." }`. When you get this, run the heuristic extractor.
`CaptureResponse.tasks` should list all open tasks, so query TASKS yourself (section 5).

Validated constraint values:
- `fixed_block {title, starts_at "HH:MM", ends_at "HH:MM"|null, location|null}`
- `cash {amount, until "YYYY-MM-DD"|null}`
- `time_window {minutes}`
- `travel {minutes, to|null}`

### BUILD_PLAN(STUDENT_ID VARCHAR, CAPTURE_ID VARCHAR, EXTRA_CONTEXT VARIANT) RETURNS VARIANT

Recommended form:
```js
conn.execute({
  sqlText: 'CALL PIP.APP.BUILD_PLAN(?, ?, PARSE_JSON(?))',
  binds: [studentId, captureIdOrNull, JSON.stringify(extraContext)],
})
```
If your account rejects `PARSE_JSON(?)` inside CALL, use `CALL PIP.APP.BUILD_PLAN(?, ?, ?)` and bind the JSON **string**. VARCHAR casts implicitly to VARIANT, and the procedure `JSON.parse`s string input. Both forms are handled. `CAPTURE_ID` may be bound as `null`.

`EXTRA_CONTEXT`:
```json
{ "now_local": "YYYY-MM-DDTHH:MI:SS",    // scenario clock; missing/invalid -> CURRENT_TIMESTAMP
  "available_minutes": 25,                // optional
  "cash_available": 20,                   // optional
  "question": "I only have 25 minutes.",  // optional
  "previous_plan_id": "...",              // optional
  "trigger": "capture" | "rerank" | "seed",
  "skip_llm": true }                      // optional Pip extension: deterministic plan only, model "sql-prerank"
```
- Send `now_local` without an offset. Seconds count: 13:13:30 gives 46 free minutes, not 47.
- For a rerank, pass the previous plan's `capture_id` if you want that capture's constraints to apply again (fixed_block, cash, time_window). Pass `null` otherwise. Either way, the new PLANS row stores what you pass.
- Seeding: call with `trigger:'seed'` and `skip_llm:true` for a fast deterministic Today Plan.

Returns a `Plan` exactly as in `api/src/types.ts`:
`{plan_id, student_id, capture_id, created_at, model, do_now, next, today, can_wait, reasoning}`.
- `model` is the Cortex model that wrote the wording (`claude-sonnet-4-5`, `mistral-large2`, `llama3.1-8b`). It is `sql-prerank` when there are no tasks, `skip_llm` is set, or both Cortex attempts failed.
- The response may carry an extra top-level `cortex_errors: string[]`, only when Cortex failed. Log it and strip it before sending the plan to iOS. It is not stored in PLANS.
- PlanItems: `item_id`, `kind` (`task` | `fixed_block`), `task_id`, `title`, `action`, `category`, `why`, `starts_at`, `ends_at`, `est_minutes`, `due_at`, `money_at_risk`, `location` (task items: null), `flag` (`at_risk` | `balance_guard` | null), `rules_fired` (RuleId[]), `evidence: []`, `curve: []`, `curve_kind`.
- `next` is `block:<dow>:<HH:MM>` when a fixed block remains today. Otherwise it is the second-best fitting task, and that task also appears in `today` or `can_wait`.
- Later fixed blocks today appear inside `today` as `fixed_block` items, after the slotted tasks and before rest/guard items.
- A `<task_id>#cont` item may appear in `today`. Its `task_id` is the real id and its `est_minutes` is the remaining minutes.
- `reasoning` is `PlanReasoning` with every key present:
  - `free_window` is always an object.
  - `context.available_minutes` also reflects a `time_window` constraint of the capture.
  - `budget_until`, `days_until_budget` and `daily_budget` are null when no budget date is known.

How the LLM is constrained (so plans stay deterministic):
- `do_now` is always the SQL pre-rank's choice.
- Section membership and order always come from the skeleton.
- The LLM contributes `action`, `why` (cut to one sentence), `title`, `summary` and `answer` (answer only when a question was asked).
- The LLM may also supply today slot times. They are accepted only when both are valid, same day, not in the past, not overlapping a fixed block, at most 180 min long, and the item is not flagged or rest.

Semantics chosen where CONTRACT was open:
- Guard items are never `do_now`.
- A fixed_block constraint with no `ends_at` lasts 60 min.
- A timetable/constraint block with the same start minute is deduplicated.
- Precedence: `EXTRA_CONTEXT.available_minutes` over a capture `time_window`. `EXTRA_CONTEXT.cash_available` over a capture `cash` constraint, over PROFILE.
- Slot sessions are at least 5 minutes long. Slots that would pass midnight get null times.
- Aligned with `api/src/ranker/plan.ts` (review pass; no shape change):
  - `do_now.starts_at` is the free window's start: now, or the end of the block the student is in right now. With no next block, slotting starts 15 min after do_now counted from that window start, so nothing is slotted inside the current block.
  - Only `rest` tasks go to bedtime. A balance-guard `meal` task is slotted like any other today task, keeps `flag:'balance_guard'`, and its sentence cites its slot time.
  - A dated task whose next open slot starts at or after its deadline gets `starts_at`/`ends_at` null and a `reasoning.warnings` entry ("… is due …, before your next open slot at …").
  - A `#cont` item is added for an assignment/work do_now with `est_minutes > first_step` even when the first step does not fit.
  - Pre-rank order is score desc, then earliest `due_at` (undated last), then task_id. `hours_open` is clamped at 0, and a `cliff` category with no due date reports `curve_kind:'linear'`.
  - The at_risk warning starts with the task title: "Return headphones for refund needs ~35 min, you have 25 before CHEM 110 Lab, due 5:00 PM during CHEM 110 Lab — $79 at risk unless you find 10 more minutes."
  - `free_window.label` without a next block is "3 h 59 min free today", or "39 min free today" under an hour.
  - When every Cortex function/model fails, the chain is walked once (not twice), so `cortex_errors` lists each attempt once.
- `created_at` of plans, actions and constraints is stored with milliseconds so same-second rows order correctly. Returned strings, and `TO_VARCHAR(col, 'YYYY-MM-DD"T"HH24:MI:SS')`, stay without fractional seconds.

### RECORD_ACTION(STUDENT_ID VARCHAR, PLAN_ID VARCHAR, TASK_ID VARCHAR, KIND VARCHAR) RETURNS VARIANT

```js
conn.execute({ sqlText: 'CALL PIP.APP.RECORD_ACTION(?, ?, ?, ?)', binds: [studentId, planId, taskIdOrNull, kind] })
```
Returns `Action` `{action_id, student_id, plan_id, task_id, kind, created_at}`. Invalid kind returns `{error}`.
Status changes (scoped to `student_id`):
- `done`: status `done`
- `defer`: status `deferred`, `defer_count + 1`
- `drop`: status `dropped`
- `start_now`: no change

For `ActionResponse.task`, re-select the task (section 5).

## 3. Datetimes

- Every datetime string the procedures return is local wall time, `YYYY-MM-DDTHH:MI:SS`, with no offset and no fractional seconds. That covers `created_at`, `due_at`, `starts_at`, `ends_at`, `reasoning.now`, `free_window.*_at` and constraint/action `created_at`.
- **The API must append the local offset** to every IsoDateTime field before responding.
- `budget_until` and `until` are `YYYY-MM-DD`. Timetable times are `HH:MM`.
- In your own SELECTs use `TO_VARCHAR(col, 'YYYY-MM-DD"T"HH24:MI:SS')`, `TO_VARCHAR(date_col, 'YYYY-MM-DD')` and `TO_VARCHAR(time_col, 'HH24:MI')`. Never use SDK Date objects.
- Money comes back as JSON numbers (79, not "79.00") when you cast `::FLOAT` in SELECTs.

## 4. Identifiers

- Every table, column and view is created **unquoted**. Snowflake stores the names in upper case, and snowflake-sdk rows use upper-case keys (`row.TASK_ID`). Alias columns in your SELECTs if you want other keys.
- Columns named `next`, `today`, `value`, `key`, `kind`, `source` are not reserved words and are used unquoted.
- **The only quoted identifier is `"TRIGGER"`**, a column of `V_PLAN_HISTORY`. TRIGGER is reserved, so select it as `"TRIGGER"` (upper case).
- JSON keys inside VARIANT columns (`do_now`, `reasoning`, ...) are lower-case snake_case. Prefer `GET(col, 'key')` over `col:key` for keys that look like keywords (e.g. `GET(reasoning, 'trigger')`).

## 5. What the API still does

- Hydrate `evidence` (5 RuleEvidence entries per task item, in RULE_IDS order) and `curve` points for every task item. `curve_kind` is already set; it is `cliff` when money_at_risk > 0 and due_at is set.
- Add offsets to datetimes (section 3). Compute `diff` / `PlanMove`s.
- Carry the previous plan's context forward and parse minutes/cash from `question`.
- Transcription, and writing CORTEX_CONFIG from `/health`.
- `CaptureResponse.tasks` (all open tasks).

## 6. CORTEX_CONFIG

| key | values |
|---|---|
| `complete_fn` | `AI_COMPLETE` \| `SNOWFLAKE.CORTEX.COMPLETE` \| NULL |
| `complete_model` | `claude-sonnet-4-5` \| `mistral-large2` \| `llama3.1-8b` \| NULL |
| `embed_fn` | `AI_EMBED` \| `SNOWFLAKE.CORTEX.EMBED_TEXT_768` \| NULL |
| `transcribe_fn` | `AI_TRANSCRIBE` \| NULL |

- The procedures try the configured `complete_fn`/`complete_model` first, then the full chain. The model name is inlined as a literal (it must match `^[a-z0-9][a-z0-9.-]*$`) and the prompt is a bind.
- Map to `CortexStatus`: `transcribe` = transcribe_fn, `complete` = complete_fn, `complete_model`, `embed` = embed_fn, `verified_at` = MAX(verified_at).
- The verification block in 03 classifies AI_TRANSCRIBE by error text only. `/health?refresh=1` should confirm with a real staged m4a.

Write from /health:
```sql
MERGE INTO PIP.APP.CORTEX_CONFIG t
USING (SELECT ? AS k, ? AS v) s ON t.key = s.k
WHEN MATCHED THEN UPDATE SET value = s.v, verified_at = CURRENT_TIMESTAMP()::TIMESTAMP_NTZ
WHEN NOT MATCHED THEN INSERT (key, value, verified_at) VALUES (s.k, s.v, CURRENT_TIMESTAMP()::TIMESTAMP_NTZ);
```
Read:
```sql
SELECT key AS k, value AS v, TO_VARCHAR(verified_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS verified_at FROM PIP.APP.CORTEX_CONFIG;
```

## 7. Example SQL

Voice capture:
```sql
-- upload (snowflake-sdk): PUT file://<tmp>/<capture_id>.m4a @PIP.APP.AUDIO_STAGE/demo/ AUTO_COMPRESS = FALSE OVERWRITE = TRUE
SELECT AI_TRANSCRIBE(TO_FILE('@PIP.APP.AUDIO_STAGE', ?)):text::STRING AS TRANSCRIPT;   -- bind 'demo/<capture_id>.m4a'
INSERT INTO PIP.APP.CAPTURES (capture_id, student_id, audio_stage_path, transcript, source, created_at)
SELECT ?, ?, ?, ?, ?, CURRENT_TIMESTAMP()::TIMESTAMP_NTZ;   -- capture_id from the API (or SELECT UUID_STRING())
SELECT capture_id, student_id, audio_stage_path, transcript, source,
       TO_VARCHAR(created_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS created_at
FROM PIP.APP.CAPTURES WHERE capture_id = ?;
```

Open tasks (Task shape):
```sql
SELECT task_id, student_id, capture_id, raw_text, normalized_text, category,
       TO_VARCHAR(due_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS due_at, money_at_risk::FLOAT AS money_at_risk,
       est_minutes, status, defer_count, TO_VARCHAR(created_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS created_at
FROM PIP.APP.TASKS WHERE student_id = ? AND status IN ('open', 'deferred') ORDER BY created_at;
```

Timetable (today uses the scenario clock's ISO day, so pass it rather than relying on CURRENT_DATE):
```sql
SELECT student_id, day_of_week, title, TO_VARCHAR(starts_at, 'HH24:MI') AS starts_at,
       TO_VARCHAR(ends_at, 'HH24:MI') AS ends_at, location
FROM PIP.APP.TIMETABLE WHERE student_id = ? AND day_of_week = ? ORDER BY starts_at;        -- today
SELECT ... FROM PIP.APP.TIMETABLE WHERE student_id = ? ORDER BY day_of_week, starts_at;    -- week
-- PUT /timetable (replace the week): run both in one transaction (BEGIN; ... COMMIT;)
DELETE FROM PIP.APP.TIMETABLE WHERE student_id = ?;
INSERT INTO PIP.APP.TIMETABLE (student_id, day_of_week, title, starts_at, ends_at, location)
SELECT ?, ?, ?, TO_TIME(?, 'HH24:MI'), TO_TIME(?, 'HH24:MI'), ?;   -- one statement per block
```
`V_TODAY_TIMETABLE` and `V_FREE_WINDOWS` use the real `CURRENT_DATE`/`CURRENT_TIMESTAMP`. They are for Snowsight and the demo, not for the frozen scenario clock.

Profile:
```sql
SELECT student_id, chronotype, cooks_own_meals, cash_available::FLOAT AS cash_available,
       TO_VARCHAR(budget_until, 'YYYY-MM-DD') AS budget_until, procrastinates_on,
       TO_VARCHAR(updated_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS updated_at
FROM PIP.APP.PROFILE WHERE student_id = ?;
-- PUT /profile partial merge: build the full row in TypeScript (current values + patch), then
MERGE INTO PIP.APP.PROFILE t
USING (SELECT ? AS student_id, ? AS chronotype, ?::BOOLEAN AS cooks_own_meals, ?::NUMBER(10,2) AS cash_available,
              TRY_TO_DATE(?, 'YYYY-MM-DD') AS budget_until, ? AS procrastinates_on) s
ON t.student_id = s.student_id
WHEN MATCHED THEN UPDATE SET chronotype = s.chronotype, cooks_own_meals = s.cooks_own_meals,
  cash_available = s.cash_available, budget_until = s.budget_until, procrastinates_on = s.procrastinates_on,
  updated_at = CURRENT_TIMESTAMP()::TIMESTAMP_NTZ
WHEN NOT MATCHED THEN INSERT (student_id, chronotype, cooks_own_meals, cash_available, budget_until, procrastinates_on, updated_at)
  VALUES (s.student_id, s.chronotype, s.cooks_own_meals, s.cash_available, s.budget_until, s.procrastinates_on, CURRENT_TIMESTAMP()::TIMESTAMP_NTZ);
```

A plan by id (for rerank / diff):
```sql
SELECT plan_id, student_id, capture_id, model, TO_VARCHAR(created_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS created_at,
       do_now, next, today, can_wait, reasoning
FROM PIP.APP.PLANS WHERE plan_id = ?;
```

History (newest first) with actions:
```sql
SELECT plan_id, capture_id, TO_VARCHAR(created_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS created_at, model,
       "TRIGGER" AS plan_trigger, transcript, context, do_now_task_id, do_now_title, previous_do_now_title,
       do_now_changed, changed
FROM PIP.APP.V_PLAN_HISTORY WHERE student_id = ? ORDER BY created_at DESC LIMIT 50;

SELECT a.action_id, a.student_id, a.plan_id, a.task_id, a.kind,
       TO_VARCHAR(a.created_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS created_at, t.normalized_text AS task_title
FROM PIP.APP.ACTIONS a LEFT JOIN PIP.APP.TASKS t ON t.task_id = a.task_id
WHERE a.student_id = ? ORDER BY a.created_at;
```
- `changed` is one of: `'first plan'`, `'do now: A → B'`, `'same do now; today reordered'` or `'no change'`.
- The history is ordered by `created_at` per student. It does not follow `previous_plan_id`.
- `context` is a VARIANT (PlanContext).

Pivot log:
```sql
SELECT entry_id, pivot_number, revealed, assumption_changed, response, cut, sentence,
       TO_VARCHAR(created_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS created_at
FROM PIP.APP.PIVOT_LOG ORDER BY pivot_number;
INSERT INTO PIP.APP.PIVOT_LOG (entry_id, pivot_number, revealed, assumption_changed, response, cut, sentence, created_at)
SELECT ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP()::TIMESTAMP_NTZ;
```
Seeded entries have ids `pivot-1` and `pivot-2`.

## 8. Demo seed

`05_seed.sql` anchors dates to the session's `CURRENT_DATE`/`CURRENT_TIMESTAMP`.
- `created_at` is real now minus N hours, not scenario now minus N.
- `npm run seed` should re-anchor the six `demo-*` tasks to the scenario clock and insert the seeded Today Plan, e.g. `BUILD_PLAN('demo', NULL, {now_local, trigger:'seed', skip_llm:true})`.
- 05 also sets any non-`demo-*` open tasks of `demo` to `dropped`.

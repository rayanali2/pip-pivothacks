# Pip contract (API ⇄ Snowflake ⇄ iOS)

`api/src/types.ts` holds the exact JSON types. This document covers what those types mean, the endpoints, the ranker, the demo data and the Snowflake procedure interfaces. Every part of the repo must agree with it.

## 1. Conventions

- JSON keys are `snake_case`. iOS decodes with `JSONDecoder.keyDecodingStrategy = .convertFromSnakeCase`, so `task_id` becomes `taskId` and `do_now` becomes `doNow`.
- Datetimes (`IsoDateTime`) are local wall-clock time with a numeric offset and no fractional seconds: `2026-09-14T17:00:00-07:00`. Dates (`IsoDate`) are `YYYY-MM-DD`. Times of day are 24-hour `HH:MM`.
- In Snowflake, every timestamp column is `TIMESTAMP_NTZ` holding local wall time. The API sets the session `TIMEZONE` to `PIP_TIMEZONE`, which defaults to the laptop's IANA zone. When reading from Snowflake, the API selects timestamps as `TO_VARCHAR(col, 'YYYY-MM-DD"T"HH24:MI:SS')` and adds the local offset in TypeScript. Never rely on snowflake-sdk Date objects, because it reads NTZ as UTC.
- `day_of_week` uses ISO numbering: 1 = Monday … 7 = Sunday (`DAYOFWEEKISO`).
- Money is in dollars as a JSON number. Durations are whole minutes.
- Every HTTP response body includes `source: 'snowflake' | 'fallback'`. MOCK_MODE always returns `'fallback'`. The iOS label reads "Snowflake" or "Local fallback".
- Status codes: 200 on success, 400 `{source, error}` on invalid input. Never 500: every route catches its own errors and falls back to the in-memory backend.
- The demo student id is `demo`. Every endpoint accepts `student_id`, and the iOS app always sends `demo`.

## 2. Scenario clock

Plans are computed against a scenario clock, `clock.now()`:
- If `DEMO_NOW=HH:MM`, the clock is today's date at that time, frozen.
- If `MOCK_MODE=true` and `DEMO_NOW` is unset, the clock defaults to **13:13** today, frozen. This reproduces "47 min free until CHEM 110 Lab, 2:00 PM".
- If `DEMO_NOW=real`, or live mode runs without `DEMO_NOW`, the clock is the real local time.

`reasoning.now` is the scenario clock. Record timestamps (`created_at` on captures, plans and actions) always use the real wall clock, so History shows when decisions were actually made.

## 3. Endpoints

| Method & path | Body / query | Response type |
|---|---|---|
| GET `/health` | `?refresh=1` re-verifies Cortex | `HealthResponse` |
| POST `/captures/voice` | multipart: `audio` file (m4a), `student_id`, optional `followup_plan_id` | `CaptureResponse` |
| POST `/captures/text` | `CaptureTextRequest` (+ optional `followup_plan_id`) | `CaptureResponse` |
| POST `/plans/rerank` | `RerankRequest` | `RerankResponse` |
| GET `/timetable/today?student_id=` | | `TodayTimetableResponse` |
| GET `/timetable?student_id=` | full week (added for the Schedule screen) | `TimetableResponse` |
| PUT `/timetable` | `PutTimetableRequest`: replaces the student's whole week | `TimetableResponse` |
| GET `/profile?student_id=` | added for the Schedule screen | `ProfileResponse` |
| PUT `/profile` | `PutProfileRequest`: partial merge | `ProfileResponse` |
| POST `/actions` | `ActionRequest` | `ActionResponse` |
| GET `/history?student_id=` | newest first | `HistoryResponse` |
| GET `/pivot-log` | ordered by pivot_number | `PivotLogResponse` |
| POST `/pivot-log` | `PivotLogCreateRequest` | `PivotLogCreateResponse` |
| POST `/demo/reset` | `{student_id}`: resets the in-memory store to the demo baseline | `DemoResetResponse` |

Capture pipeline:
- **Live:** stage upload → `AI_TRANSCRIBE` → insert CAPTURES → `CALL EXTRACT_FROM_TRANSCRIPT` → `CALL BUILD_PLAN`.
- **Fallback / mock:** heuristic extract → in-memory store → TypeScript ranker.

When a capture includes `followup_plan_id`, it is treated as a rerank: the transcript becomes `context.question`, the minutes and cash are parsed from the text, and no new tasks are extracted. The response then carries `diff` and `previous_plan_id`.

Mock voice capture ignores the audio. It returns the demo transcript, or "I only have 25 minutes." when `followup_plan_id` is present.

Actions change task status as follows:
- `done` → status `done`
- `defer` → status `deferred`, `defer_count + 1`
- `drop` → status `dropped`
- `start_now` → no change

The ranker treats `open` and `deferred` tasks as open.

Rerank context:
- Carries forward the previous plan's `context` and merges the new values on top.
- If `available_minutes` is absent, it is parsed from `question`: `(\d+)\s*(min|mins|minutes)`, "half an hour" = 30, "an hour"/"1 hour" = 60, `(\d+)\s*hours?` = N×60.
- If `cash_available` is absent, it is parsed from `\$(\d+(\.\d+)?)`.

Follow-up question answers (`reasoning.answer`), deterministic templates:
- "afford / money / budget / cash / spend": cash, days until `budget_until`, daily budget, the grocery cap, and money at risk.
- "why not <x>": find the open task whose text best matches <x>, then compare its deadline and rules with do_now's.
- Otherwise `null`, unless minutes or cash were parsed. In that case the answer restates what changed.

## 4. Ranker (identical intent in TypeScript `api/src/ranker` and SQL `BUILD_PLAN` pre-rank)

Inputs: `now`, open tasks, today's timetable blocks plus any `fixed_block` constraints from the capture (deduplicated by start time), the profile (a `cash` constraint from the capture overrides `cash_available` and `budget_until`), `DECAY_CONFIG`, and context.

**Free window.** Sort today's blocks.
- If `now` falls inside a block, the window starts at that block's end.
- The window ends at the next block's start, or 23:59 if there is none.
- `minutes = floor(end − start)`.
- Label: `"{minutes} min free until {next.title}, {h:mm AM/PM}"`. If there is no next block: `"{h} h {m} min free today"`.

`effective_minutes = min(free.minutes, context.available_minutes ?? ∞)`. A `time_window` constraint behaves like `available_minutes`.

**First step minutes.**
- `assignment | work | class`: `min(est_minutes ?? 60, 20)`.
- Everything else: `est_minutes ?? 15`.

**Rules.** A task with `due_at <= now` is skipped and its status becomes `expired`.
1. `irreversible_loss`: (`money_at_risk > 0` and `due_at <= now + 24h`) or (`category in (assignment, work, money)` and `due_at <= now + 12h`).
2. `fixed_block_collision`: `due_at` is set, a next block exists today (`starts_at > now`), and `due_at <= next_block.ends_at`. In words: the deadline is gone by the end of the next fixed block, so this window is the last chance.
3. `basic_needs`: `category in (meal, rest)`, or `normalized_text` / `raw_text` matches (case-insensitive) `grocer|medic|pharm|prescription|sleep|lunch|dinner|breakfast|meal`.
4. `fits_window`: `effective_minutes > 0` and `first_step_minutes <= effective_minutes`.
5. `academic_deadline`: `category in (assignment, class, work)` and `due_at <= now + 48h`.

`score = 10000·R1 + 1000·R2 + 100·R3 + 10·R4 + 1·R5 + tiebreak`

`tiebreak = round(0.99 · cost(task, 2h), 4)`, where `cost` comes from the decay curve below (range 0…1).

**Balance guard (36h).** Fires for `category in (meal, rest)` when `now − created_at >= 36h` or `defer_count >= 2`. The item gets `flag = 'balance_guard'` and always lands in `today`. Its sentence is added to `reasoning.balance_guard`.

**Sections.**
- **do_now**: the highest score among tasks with R4 and `category != rest`. If there is none, take the highest-scoring non-rest task and say in `why` that it won't finish in the window.
- **next**: if a next block exists today, a `fixed_block` item. Its action is "Be at {location or title} by {h:mm}", and its why gives the minutes left after do_now (`effective_minutes − do_now.first_step_minutes`). With no next block, `next` is the second-best fitting task.
- **at_risk**: any task with R1 and R2 but not R4. It gets `flag = 'at_risk'`, goes first in `today` with `starts_at = null`, and adds an entry to `reasoning.warnings`.
- **today**: tasks (other than do_now) with R1, R2, R3, R5 or the guard, in this order:
  1. at_risk items.
  2. Dated tasks, earliest due first.
  3. Undated tasks by score, descending.
  4. Guard/rest items at bedtime.

  Slotting starts 15 min after the next block ends, or 15 min after do_now if there is no block. Each session is `min(remaining est, 90)` minutes, with 15 min between slots. Bedtime depends on chronotype: early_bird 22:30, neutral 23:00, night_owl 23:30. Rest or guard items start at bedtime with `ends_at = null`. If do_now is an assignment/work task with `est_minutes > first_step_minutes`, `today` also gets `{task_id}#cont` for the rest of the work.

  Fixed blocks after the next block are included at their times.
- **can_wait**: everything else, by score descending. The why says why deferring is safe (no deadline within 48h, no money at risk, defer count).

**Money.**
- `days_until_budget = max(1, budget_until − today in days)`
- `daily_budget = round(cash / days, 2)`
- `grocery_cap = floor(cash · 0.6)`

The groceries action and why cite the cap and what's left. "Friday" in speech means the next Friday strictly after today.

**Decay curves** (tiebreak + `curve`, points at hours `[0,1,2,3,4,6,8,12,18,24,36,48]`):
- `cliff`: before due, `floor + (0.5 − floor)·(t / hours_to_due)`; at or after due, `1.0`. With no due date, fall back to `linear`. A task with `money_at_risk > 0` and a `due_at` always uses `cliff`.
- `linear`: `min(1, floor + t / (2·half_life))`
- `daily_reset`: `floor + (1 − floor)·(((hours_open + t) mod 24) / 24)`
- `rising_floor`: `min(1, floor + (hours_open + t) / (2·half_life))`
- `defer_multiplier`: `min(1, (floor + t / (2·half_life)) · (1 + 0.5·defer_count))`

DECAY_CONFIG seed (category, curve, half_life_hours, floor_weight):

| category | curve | half_life_hours | floor_weight |
|---|---|---|---|
| class | cliff | 24 | 0.2 |
| assignment | cliff | 48 | 0.1 |
| work | cliff | 24 | 0.2 |
| errand | linear | 72 | 0.1 |
| meal | daily_reset | 24 | 0.3 |
| rest | rising_floor | 36 | 0.2 |
| money | cliff | 24 | 0.2 |
| social | defer_multiplier | 168 | 0.05 |
| club | defer_multiplier | 168 | 0.05 |

**Evidence.** Every task item has exactly 5 `RuleEvidence` entries, in RULE_IDS order. Labels:
1. "Irreversible deadline or money loss"
2. "Collides with a fixed class/lab block"
3. "Affects basic needs today"
4. "First step fits the free window"
5. "Near academic deadline"

Each `detail` sentence cites numbers whether or not the rule fired.

**Why.** One sentence, no score numbers. Cite deadline times (`h:mm AM/PM`), dollars, free minutes and the next block.

## 5. Demo data (baseline; `N` = scenario now, `D` = today's date)

Profile `demo`: chronotype `night_owl`, cooks_own_meals `true`, cash_available `35`, budget_until = next Friday strictly after D, procrastinates_on `assignment`.

Timetable (ISO dow, title, start–end, location):
- 1 CHEM 110 Lecture 10:00–11:20 Science Hall 120
- 2 MATH 151 Calculus 09:30–10:50 Math Building 210
- 3 CHEM 110 Lecture 10:00–11:20 Science Hall 120
- 4 MATH 151 Calculus 09:30–10:50 Math Building 210
- 5 CS 101 Tutorial 11:30–12:20 Tech Hub 3
- **today's dow**: CHEM 110 Lab 14:00–17:00 Science Hall 204. This is always added for today's day of week, weekends included.

Open tasks:

| task_id | raw_text | normalized_text | category | due_at | money_at_risk | est | defer | created_at |
|---|---|---|---|---|---|---|---|---|
| demo-return-headphones | I need to return headphones by 5 PM or lose the refund | Return headphones for refund | errand | D 17:00 | 79 | 35 | 0 | N−20h |
| demo-assignment | My assignment is due tomorrow | Finish CS 101 assignment | assignment | D+1 23:59 | null | 180 | 1 | N−72h |
| demo-groceries | I need groceries | Buy groceries within budget | errand | null | null | 40 | 1 | N−30h |
| demo-sleep | I keep skipping sleep | Get a full night's sleep | rest | null | null | 480 | 2 | N−40h |
| demo-laundry | Do laundry | Do laundry | errand | null | null | 90 | 0 | N−24h |
| demo-club-rsvp | RSVP to the Outdoors Club hike | RSVP to Outdoors Club hike | club | next Friday 17:00 | null | 5 | 1 | N−48h |

Demo transcript:

> I have a 2 PM lab. I need to return headphones by 5 PM or lose the refund. My assignment is due tomorrow. I need groceries, and I have $35 until Friday. What should I do?

Extracting it yields:
- The return, assignment and groceries tasks, merged into the existing ones: same category and a shared key noun or token Jaccard ≥ 0.5, which in Snowflake is `JAROWINKLER_SIMILARITY >= 80` or the LLM's `existing_task_id`.
- Constraints: `fixed_block {title:"Lab", starts_at:"14:00", ends_at:null, location:null}` and `cash {amount:35, until:<next Friday>}`.

### Expected plan at N = 13:13 (effective 47)

Free window label: "47 min free until CHEM 110 Lab, 2:00 PM".

Scores:

| task | rules fired | score |
|---|---|---|
| return | R1, R2, R4 | 11010.x |
| groceries | R3, R4 | 110.x |
| sleep | R3, guard | 100.x |
| assignment | R4, R5 | 11.x |
| club | R4 | 10.x |
| laundry | none | 0.x |

Sections:
- **do_now** = `demo-return-headphones`
- **next** = `block:{dow}:14:00` (CHEM 110 Lab; 12 min spare after the 35-min return)
- **today** = [`demo-assignment` 17:15–18:45, `demo-groceries` 19:00–19:40 (cap $21), `demo-sleep` 23:30 (balance_guard)]
- **can_wait** = [`demo-club-rsvp`, `demo-laundry`]

### Expected rerank "I only have 25 minutes" (effective 25)

Scores:

| task | rules fired | score | note |
|---|---|---|---|
| return | R1, R2 | 11000.x | at_risk: 35 > 25 |
| groceries | R3 | 100.x | |
| sleep | R3, guard | 100.x | |
| assignment | R4, R5 | 11.x | |
| club | R4 | 10.x | |
| laundry | none | 0.x | |

Sections:
- **do_now** = `demo-assignment` (outline, 20 min)
- **next** = the lab block (5 min spare)
- **today** = [`demo-return-headphones` (flag at_risk), `demo-assignment#cont` 17:15–18:45, `demo-groceries` 19:00–19:40, `demo-sleep` 23:30]
- **can_wait** = [`demo-club-rsvp`, `demo-laundry`]
- **warnings** includes the return: "needs ~35 min, you have 25 before CHEM 110 Lab, returns close 5:00 PM during Lab — $79 refund at risk unless you find 10 more minutes".
- **diff.headline** ≈ "Only 25 min: the 35-min return won't fit before Lab ($79 at risk), so do now is the assignment outline."

## 6. Snowflake procedures (database PIP, schema APP)

- `EXTRACT_FROM_TRANSCRIPT(CAPTURE_ID VARCHAR) RETURNS VARIANT`
  - Returns `{tasks: Task[], constraints: Constraint[], model: string, attempts: number}`.
  - Inserts or merges into TASKS and inserts into CONSTRAINTS.
- `BUILD_PLAN(STUDENT_ID VARCHAR, CAPTURE_ID VARCHAR, EXTRA_CONTEXT VARIANT) RETURNS VARIANT`
  - Returns a `Plan` (types.ts). Items may leave `evidence: []` and `curve: []`, because the API hydrates them.
  - `EXTRA_CONTEXT = {now_local:"YYYY-MM-DDTHH:MI:SS", available_minutes?, cash_available?, question?, previous_plan_id?, trigger:"capture"|"rerank"}`.
  - Inserts into PLANS.
- `RECORD_ACTION(STUDENT_ID VARCHAR, PLAN_ID VARCHAR, TASK_ID VARCHAR, KIND VARCHAR) RETURNS VARIANT`
  - Returns an `Action` and applies the status change.
- Extra table `CORTEX_CONFIG(key VARCHAR, value VARCHAR, verified_at TIMESTAMP_NTZ)`. Keys: `complete_fn`, `complete_model`, `transcribe_fn`, `embed_fn`. It is written by the verification block in `03_functions.sql` and by the API's `/health` verification, and read by the procedures.

## 7. iOS offline fixtures

These are generated by running the API in MOCK_MODE and saved under `ios/Pip/Pip/Resources/Offline/`. The app uses them only when the API is unreachable.

- `health.json`
- `capture_voice.json` (demo capture)
- `rerank_25.json`
- `timetable_today.json`
- `timetable_week.json`
- `profile.json`
- `history.json`
- `pivot_log.json`
- `action_start_now.json`

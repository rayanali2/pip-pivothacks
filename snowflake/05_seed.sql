-- =============================================================================
-- UniMate / Snowflake layer  --  05_seed.sql
-- Idempotent demo baseline (CONTRACT section 5). Re-run any time to reset the demo.
--
-- FIRST set the session time zone to the laptop's zone so CURRENT_DATE and
-- CURRENT_TIMESTAMP are local wall time:
--   ALTER SESSION SET TIMEZONE = 'America/Los_Angeles';
--
-- Dates here are anchored to CURRENT_DATE / CURRENT_TIMESTAMP of this session.
-- `npm run seed` (in api/) re-anchors the same rows to the laptop clock (and to the
-- scenario clock N) and inserts the seeded Today Plan (trigger 'seed').
-- =============================================================================

USE WAREHOUSE PIP_WH;
USE SCHEMA PIP.APP;

-- DECAY_CONFIG ----------------------------------------------------------------
MERGE INTO PIP.APP.DECAY_CONFIG t
USING (
  SELECT $1 AS category, $2 AS curve, $3 AS half_life_hours, $4 AS floor_weight
  FROM VALUES
    ('class',      'cliff',            24,  0.20),
    ('assignment', 'cliff',            48,  0.10),
    ('work',       'cliff',            24,  0.20),
    ('errand',     'linear',           72,  0.10),
    ('meal',       'daily_reset',      24,  0.30),
    ('rest',       'rising_floor',     36,  0.20),
    ('money',      'cliff',            24,  0.20),
    ('social',     'defer_multiplier', 168, 0.05),
    ('club',       'defer_multiplier', 168, 0.05)
) s
ON t.category = s.category
WHEN MATCHED THEN UPDATE SET curve = s.curve, half_life_hours = s.half_life_hours, floor_weight = s.floor_weight
WHEN NOT MATCHED THEN INSERT (category, curve, half_life_hours, floor_weight)
  VALUES (s.category, s.curve, s.half_life_hours, s.floor_weight);

-- Demo student ----------------------------------------------------------------
MERGE INTO PIP.APP.STUDENTS t
USING (SELECT 'demo' AS student_id) s
ON t.student_id = s.student_id
WHEN NOT MATCHED THEN INSERT (student_id, created_at) VALUES (s.student_id, CURRENT_TIMESTAMP()::TIMESTAMP_NTZ);

-- Timetable (Mon-Fri + CHEM 110 Lab on today's day of week) -----------------
DELETE FROM PIP.APP.TIMETABLE WHERE student_id = 'demo';

INSERT INTO PIP.APP.TIMETABLE (student_id, day_of_week, title, starts_at, ends_at, location)
SELECT 'demo', $1, $2, TO_TIME($3, 'HH24:MI'), TO_TIME($4, 'HH24:MI'), $5
FROM VALUES
  (1, 'CHEM 110 Lecture',  '10:00', '11:20', 'Science Hall 120'),
  (2, 'MATH 151 Calculus', '09:30', '10:50', 'Math Building 210'),
  (3, 'CHEM 110 Lecture',  '10:00', '11:20', 'Science Hall 120'),
  (4, 'MATH 151 Calculus', '09:30', '10:50', 'Math Building 210'),
  (5, 'CS 101 Tutorial',   '11:30', '12:20', 'Tech Hub 3');

INSERT INTO PIP.APP.TIMETABLE (student_id, day_of_week, title, starts_at, ends_at, location)
SELECT 'demo', DAYOFWEEKISO(CURRENT_DATE()), 'CHEM 110 Lab', TO_TIME('14:00', 'HH24:MI'), TO_TIME('17:00', 'HH24:MI'), 'Science Hall 204';

-- Profile (budget_until = next Friday strictly after today) -----------------
MERGE INTO PIP.APP.PROFILE t
USING (
  SELECT 'demo' AS student_id, 'night_owl' AS chronotype, TRUE AS cooks_own_meals,
         35.00::NUMBER(10,2) AS cash_available, NEXT_DAY(CURRENT_DATE(), 'FR') AS budget_until,
         'assignment' AS procrastinates_on
) s
ON t.student_id = s.student_id
WHEN MATCHED THEN UPDATE SET
  chronotype = s.chronotype, cooks_own_meals = s.cooks_own_meals, cash_available = s.cash_available,
  budget_until = s.budget_until, procrastinates_on = s.procrastinates_on, updated_at = CURRENT_TIMESTAMP()::TIMESTAMP_NTZ
WHEN NOT MATCHED THEN INSERT
  (student_id, chronotype, cooks_own_meals, cash_available, budget_until, procrastinates_on, updated_at)
  VALUES (s.student_id, s.chronotype, s.cooks_own_meals, s.cash_available, s.budget_until, s.procrastinates_on,
          CURRENT_TIMESTAMP()::TIMESTAMP_NTZ);

-- Open tasks (reset to the baseline every run) -------------------------------
MERGE INTO PIP.APP.TASKS t
USING (
  SELECT 'demo-return-headphones' AS task_id,
         'I need to return headphones by 5 PM or lose the refund' AS raw_text,
         'Return headphones for refund' AS normalized_text,
         'errand' AS category,
         DATEADD(hour, 17, CURRENT_DATE()::TIMESTAMP_NTZ) AS due_at,
         79.00::NUMBER(10,2) AS money_at_risk,
         35::NUMBER(6,0) AS est_minutes,
         0::NUMBER(6,0) AS defer_count,
         DATEADD(hour, -20, CURRENT_TIMESTAMP()::TIMESTAMP_NTZ) AS created_at
  UNION ALL
  SELECT 'demo-assignment', 'My assignment is due tomorrow', 'Finish CS 101 assignment', 'assignment',
         DATEADD(minute, 1439, DATEADD(day, 1, CURRENT_DATE())::TIMESTAMP_NTZ),
         CAST(NULL AS NUMBER(10,2)), 180, 1,
         DATEADD(hour, -72, CURRENT_TIMESTAMP()::TIMESTAMP_NTZ)
  UNION ALL
  SELECT 'demo-groceries', 'I need groceries', 'Buy groceries within budget', 'errand',
         CAST(NULL AS TIMESTAMP_NTZ), CAST(NULL AS NUMBER(10,2)), 40, 1,
         DATEADD(hour, -30, CURRENT_TIMESTAMP()::TIMESTAMP_NTZ)
  UNION ALL
  SELECT 'demo-sleep', 'I keep skipping sleep', 'Get a full night''s sleep', 'rest',
         CAST(NULL AS TIMESTAMP_NTZ), CAST(NULL AS NUMBER(10,2)), 480, 2,
         DATEADD(hour, -40, CURRENT_TIMESTAMP()::TIMESTAMP_NTZ)
  UNION ALL
  SELECT 'demo-laundry', 'Do laundry', 'Do laundry', 'errand',
         CAST(NULL AS TIMESTAMP_NTZ), CAST(NULL AS NUMBER(10,2)), 90, 0,
         DATEADD(hour, -24, CURRENT_TIMESTAMP()::TIMESTAMP_NTZ)
  UNION ALL
  SELECT 'demo-club-rsvp', 'RSVP to the Outdoors Club hike', 'RSVP to Outdoors Club hike', 'club',
         DATEADD(hour, 17, NEXT_DAY(CURRENT_DATE(), 'FR')::TIMESTAMP_NTZ),
         CAST(NULL AS NUMBER(10,2)), 5, 1,
         DATEADD(hour, -48, CURRENT_TIMESTAMP()::TIMESTAMP_NTZ)
) s
ON t.task_id = s.task_id
WHEN MATCHED THEN UPDATE SET
  student_id = 'demo', capture_id = NULL, raw_text = s.raw_text, normalized_text = s.normalized_text,
  category = s.category, due_at = s.due_at, money_at_risk = s.money_at_risk, est_minutes = s.est_minutes,
  status = 'open', defer_count = s.defer_count, created_at = s.created_at
WHEN NOT MATCHED THEN INSERT
  (task_id, student_id, capture_id, raw_text, normalized_text, category, due_at, money_at_risk, est_minutes,
   status, defer_count, created_at)
  VALUES (s.task_id, 'demo', NULL, s.raw_text, s.normalized_text, s.category, s.due_at, s.money_at_risk,
          s.est_minutes, 'open', s.defer_count, s.created_at);

-- Tasks created by earlier demo captures are closed so the baseline is exactly the six above.
UPDATE PIP.APP.TASKS SET status = 'dropped'
WHERE student_id = 'demo' AND task_id NOT LIKE 'demo-%' AND status IN ('open', 'deferred');

-- Pivot log ---------------------------------------------------------------------
MERGE INTO PIP.APP.PIVOT_LOG t
USING (
  SELECT 'pivot-1' AS entry_id, 1 AS pivot_number,
         'Problem 7 — Prioritization' AS revealed,
         'Generic user' AS assumption_changed,
         'Voice-first ranker with decay curves, with Snowflake as the brain' AS response,
         'None' AS cut,
         'Problem 7 is prioritization, so UniMate turns a spoken, overloaded day into one ranked next action with Snowflake Cortex as the brain.' AS sentence
  UNION ALL
  SELECT 'pivot-2', 2,
         'User is a first-time independent university student',
         'Generic urgency → practical cost of delay against classes, money, and basic needs',
         'Timetable, budget window, free-window math, basic-needs guard; Today Plan replaces the score',
         'Generic corpus comparison',
         'We learned our user is a first-time independent student, so UniMate now plans around classes, money, and practical life errands — not generic task urgency.'
) s
ON t.pivot_number = s.pivot_number
WHEN MATCHED THEN UPDATE SET
  revealed = s.revealed, assumption_changed = s.assumption_changed, response = s.response, cut = s.cut, sentence = s.sentence
WHEN NOT MATCHED THEN INSERT
  (entry_id, pivot_number, revealed, assumption_changed, response, cut, sentence, created_at)
  VALUES (s.entry_id, s.pivot_number, s.revealed, s.assumption_changed, s.response, s.cut, s.sentence,
          CURRENT_TIMESTAMP()::TIMESTAMP_NTZ);

-- Templates for later pivots (POST /pivot-log does the same through the API):
-- INSERT INTO PIP.APP.PIVOT_LOG (entry_id, pivot_number, revealed, assumption_changed, response, cut, sentence, created_at)
-- SELECT 'pivot-3', 3, '<what the judges/users revealed>', '<assumption that changed>', '<what we built in response>',
--        '<what we cut>', '<one sentence for the pitch>', CURRENT_TIMESTAMP()::TIMESTAMP_NTZ;
-- INSERT INTO PIP.APP.PIVOT_LOG (entry_id, pivot_number, revealed, assumption_changed, response, cut, sentence, created_at)
-- SELECT 'pivot-4', 4, '<revealed>', '<assumption_changed>', '<response>', '<cut>', '<sentence>', CURRENT_TIMESTAMP()::TIMESTAMP_NTZ;

-- Check ---------------------------------------------------------------------------
SELECT task_id, category, TO_VARCHAR(due_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS due_at, money_at_risk, est_minutes, status, defer_count
FROM PIP.APP.TASKS WHERE student_id = 'demo' AND status = 'open' ORDER BY task_id;

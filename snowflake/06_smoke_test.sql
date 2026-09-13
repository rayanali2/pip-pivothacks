-- =============================================================================
-- UniMate / Snowflake layer  --  06_smoke_test.sql  (optional)
-- End-to-end check: text capture -> EXTRACT_FROM_TRANSCRIPT -> BUILD_PLAN at 13:13
-- -> rerank with 25 minutes -> RECORD_ACTION -> views.
-- It changes the demo rows (merges tasks, adds constraints, plans and an action):
-- re-run 05_seed.sql afterwards to restore the baseline.
-- Run statement by statement (or Run All) in one worksheet so the session
-- variables persist.
-- =============================================================================

USE WAREHOUSE PIP_WH;
USE SCHEMA PIP.APP;
-- ALTER SESSION SET TIMEZONE = 'America/Los_Angeles';

SET cap_id = (SELECT UUID_STRING());
SET now_local = (SELECT TO_VARCHAR(CURRENT_DATE(), 'YYYY-MM-DD') || 'T13:13:00');

INSERT INTO PIP.APP.CAPTURES (capture_id, student_id, audio_stage_path, transcript, source, created_at)
SELECT $cap_id, 'demo', NULL,
       'I have a 2 PM lab. I need to return headphones by 5 PM or lose the refund. My assignment is due tomorrow. I need groceries, and I have $35 until Friday. What should I do?',
       'text', CURRENT_TIMESTAMP()::TIMESTAMP_NTZ;

-- 1. Extraction (expect the return/assignment/groceries tasks merged into the demo-* rows,
--    plus fixed_block {Lab 14:00} and cash {35, next Friday} constraints).
CALL PIP.APP.EXTRACT_FROM_TRANSCRIPT($cap_id);

SELECT kind, value FROM PIP.APP.CONSTRAINTS WHERE capture_id = $cap_id ORDER BY created_at;

-- 2. Plan at 13:13 (expect do_now demo-return-headphones, next block:<dow>:14:00,
--    label "47 min free until CHEM 110 Lab, 2:00 PM").
CALL PIP.APP.BUILD_PLAN('demo', $cap_id,
  TO_VARIANT(OBJECT_CONSTRUCT('now_local', $now_local, 'trigger', 'capture')));

SET plan1 = (SELECT plan_id FROM PIP.APP.PLANS WHERE capture_id = $cap_id ORDER BY created_at DESC LIMIT 1);

-- 3. Rerank "I only have 25 minutes" (expect do_now demo-assignment, the return flagged at_risk).
CALL PIP.APP.BUILD_PLAN('demo', $cap_id,
  TO_VARIANT(OBJECT_CONSTRUCT(
    'now_local', $now_local,
    'available_minutes', 25,
    'question', 'I only have 25 minutes.',
    'trigger', 'rerank',
    'previous_plan_id', $plan1)));

-- Deterministic variant without Cortex (fast; model = 'sql-prerank'):
-- CALL PIP.APP.BUILD_PLAN('demo', $cap_id, TO_VARIANT(OBJECT_CONSTRUCT('now_local', $now_local, 'trigger', 'capture', 'skip_llm', TRUE)));

SET plan2 = (SELECT plan_id FROM PIP.APP.PLANS WHERE student_id = 'demo' ORDER BY created_at DESC LIMIT 1);

-- 4. Action
CALL PIP.APP.RECORD_ACTION('demo', $plan2, 'demo-assignment', 'start_now');

-- 5. Inspect
SELECT plan_id, model,
       GET(do_now, 'item_id')::VARCHAR AS do_now_item,
       GET(next, 'item_id')::VARCHAR AS next_item,
       ARRAY_SIZE(today) AS today_items,
       ARRAY_SIZE(can_wait) AS can_wait_items,
       GET(GET(reasoning, 'free_window'), 'label')::VARCHAR AS free_window_label,
       GET(reasoning, 'effective_minutes') AS effective_minutes,
       GET(reasoning, 'warnings') AS warnings
FROM PIP.APP.PLANS
WHERE student_id = 'demo'
ORDER BY created_at DESC
LIMIT 5;

SELECT * FROM PIP.APP.V_TODAY_TIMETABLE WHERE student_id = 'demo' ORDER BY starts_at;
SELECT * FROM PIP.APP.V_FREE_WINDOWS WHERE student_id = 'demo' ORDER BY window_start;
SELECT plan_id, created_at, model, "TRIGGER", do_now_title, previous_do_now_title, do_now_changed, changed
FROM PIP.APP.V_PLAN_HISTORY WHERE student_id = 'demo' ORDER BY created_at DESC;
SELECT * FROM PIP.APP.ACTIONS WHERE student_id = 'demo' ORDER BY created_at DESC LIMIT 5;

-- =============================================================================
-- Pip / Snowflake layer  --  04_views.sql
-- Views use CURRENT_DATE() / CURRENT_TIMESTAMP(), so they follow the session
-- TIMEZONE (ALTER SESSION SET TIMEZONE = '<IANA zone>').
-- =============================================================================

USE WAREHOUSE PIP_WH;
USE SCHEMA PIP.APP;

-- Today's fixed blocks per student, with the times anchored to CURRENT_DATE.
CREATE OR REPLACE VIEW PIP.APP.V_TODAY_TIMETABLE AS
SELECT
  tt.student_id,
  tt.day_of_week,
  tt.title,
  tt.starts_at,
  tt.ends_at,
  tt.location,
  TIMESTAMP_NTZ_FROM_PARTS(CURRENT_DATE(), tt.starts_at) AS starts_ts,
  TIMESTAMP_NTZ_FROM_PARTS(CURRENT_DATE(), tt.ends_at)   AS ends_ts
FROM PIP.APP.TIMETABLE tt
WHERE tt.day_of_week = DAYOFWEEKISO(CURRENT_DATE());

-- Free gaps from now until 23:59 today: before each remaining block, and after the
-- last one. Students with no remaining blocks get a single window.
CREATE OR REPLACE VIEW PIP.APP.V_FREE_WINDOWS AS
WITH clock AS (
  SELECT
    CURRENT_TIMESTAMP()::TIMESTAMP_NTZ AS now_ts,
    DATEADD(minute, 1439, CURRENT_DATE()::TIMESTAMP_NTZ) AS day_end_ts
),
remaining AS (
  SELECT b.student_id, b.title, b.starts_ts, b.ends_ts
  FROM PIP.APP.V_TODAY_TIMETABLE b
  CROSS JOIN clock c
  WHERE b.ends_ts > c.now_ts
),
ordered AS (
  SELECT
    r.student_id,
    r.title,
    r.starts_ts,
    r.ends_ts,
    MAX(r.ends_ts) OVER (
      PARTITION BY r.student_id ORDER BY r.starts_ts, r.ends_ts
      ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS prev_end_ts
  FROM remaining r
),
last_blocks AS (
  SELECT r.student_id, MAX(r.ends_ts) AS last_end_ts
  FROM remaining r
  GROUP BY r.student_id
),
gaps AS (
  SELECT
    o.student_id,
    GREATEST(COALESCE(o.prev_end_ts, c.now_ts), c.now_ts) AS window_start,
    o.starts_ts AS window_end,
    o.title AS next_block_title
  FROM ordered o
  CROSS JOIN clock c
  UNION ALL
  SELECT
    l.student_id,
    GREATEST(l.last_end_ts, c.now_ts) AS window_start,
    c.day_end_ts AS window_end,
    CAST(NULL AS VARCHAR) AS next_block_title
  FROM last_blocks l
  CROSS JOIN clock c
  UNION ALL
  SELECT
    s.student_id,
    c.now_ts AS window_start,
    c.day_end_ts AS window_end,
    CAST(NULL AS VARCHAR) AS next_block_title
  FROM PIP.APP.STUDENTS s
  CROSS JOIN clock c
  WHERE NOT EXISTS (SELECT 1 FROM remaining r WHERE r.student_id = s.student_id)
)
SELECT
  g.student_id,
  g.window_start,
  g.window_end,
  FLOOR(DATEDIFF(second, g.window_start, g.window_end) / 60) AS minutes,
  g.next_block_title
FROM gaps g
WHERE g.window_end > g.window_start;

-- Plan history with a human "what changed" line per plan.
-- The column TRIGGER is a reserved word: it is created as the quoted identifier "TRIGGER"
-- (upper case, so the result column is named TRIGGER); select it as "TRIGGER".
CREATE OR REPLACE VIEW PIP.APP.V_PLAN_HISTORY AS
WITH base AS (
  SELECT
    p.plan_id,
    p.student_id,
    p.capture_id,
    p.created_at,
    p.model,
    COALESCE(GET(p.reasoning, 'trigger')::VARCHAR, 'capture') AS plan_trigger,
    c.transcript,
    GET(p.reasoning, 'context') AS context,
    GET(p.do_now, 'task_id')::VARCHAR AS do_now_task_id,
    GET(p.do_now, 'title')::VARCHAR AS do_now_title,
    p.today AS today_items
  FROM PIP.APP.PLANS p
  LEFT JOIN PIP.APP.CAPTURES c ON c.capture_id = p.capture_id
),
ids AS (
  SELECT
    b.plan_id,
    ARRAY_AGG(GET(f.value, 'item_id')::VARCHAR) WITHIN GROUP (ORDER BY f.index) AS today_ids
  FROM base b,
    LATERAL FLATTEN(INPUT => b.today_items, OUTER => TRUE) f
  GROUP BY b.plan_id
),
seq AS (
  SELECT
    b.*,
    i.today_ids,
    ARRAY_TO_STRING(i.today_ids, ',') AS today_ids_csv,
    LAG(b.plan_id)        OVER (PARTITION BY b.student_id ORDER BY b.created_at, b.plan_id) AS previous_plan_id,
    LAG(b.do_now_task_id) OVER (PARTITION BY b.student_id ORDER BY b.created_at, b.plan_id) AS previous_do_now_task_id,
    LAG(b.do_now_title)   OVER (PARTITION BY b.student_id ORDER BY b.created_at, b.plan_id) AS previous_do_now_title,
    LAG(ARRAY_TO_STRING(i.today_ids, ','))
                          OVER (PARTITION BY b.student_id ORDER BY b.created_at, b.plan_id) AS previous_today_ids_csv
  FROM base b
  LEFT JOIN ids i ON i.plan_id = b.plan_id
)
SELECT
  s.plan_id,
  s.student_id,
  s.capture_id,
  s.created_at,
  s.model,
  s.plan_trigger AS "TRIGGER",
  s.transcript,
  s.context,
  s.do_now_task_id,
  s.do_now_title,
  s.previous_do_now_title,
  (s.previous_plan_id IS NOT NULL
    AND COALESCE(s.do_now_task_id, '') <> COALESCE(s.previous_do_now_task_id, '')) AS do_now_changed,
  s.today_ids,
  CASE
    WHEN s.previous_plan_id IS NULL THEN NULL
    WHEN COALESCE(s.previous_today_ids_csv, '') = '' THEN ARRAY_CONSTRUCT()
    ELSE SPLIT(s.previous_today_ids_csv, ',')
  END AS previous_today_ids,
  CASE
    WHEN s.previous_plan_id IS NULL THEN 'first plan'
    WHEN COALESCE(s.do_now_task_id, '') <> COALESCE(s.previous_do_now_task_id, '')
      THEN 'do now: ' || COALESCE(s.previous_do_now_title, 'nothing') || ' → ' || COALESCE(s.do_now_title, 'nothing')
    WHEN COALESCE(s.today_ids_csv, '') <> COALESCE(s.previous_today_ids_csv, '')
      THEN 'same do now; today reordered'
    ELSE 'no change'
  END AS changed
FROM seq s;

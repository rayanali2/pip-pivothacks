-- =============================================================================
-- UniMate / Snowflake layer  --  01_schema.sql
-- Run the numbered files top-to-bottom in a Snowsight worksheet:
--   01_schema.sql -> 02_stage.sql -> 03_functions.sql -> 04_views.sql -> 05_seed.sql
--   (06_smoke_test.sql is optional; it mutates the demo rows, so re-run 05 after it)
-- Every file is re-runnable. Tables use CREATE TABLE IF NOT EXISTS, so re-running
-- this file never drops data.
--
-- PREREQUISITES
--   1. A role that can create a warehouse and a database (ACCOUNTADMIN or SYSADMIN
--      on a trial account).
--   2. Cortex access for that role. Trial accounts usually grant it to PUBLIC.
--      If not, run as ACCOUNTADMIN:
--        -- GRANT DATABASE ROLE SNOWFLAKE.CORTEX_USER TO ROLE <your_role>;
--   3. claude-sonnet-4-5 is not hosted in every region. If the verification block
--      in 03_functions.sql falls back to mistral-large2 / llama3.1-8b and you
--      want Claude, allow cross-region inference (ACCOUNTADMIN):
--        -- ALTER ACCOUNT SET CORTEX_ENABLED_CROSS_REGION = 'ANY_REGION';
--   4. Every timestamp column is TIMESTAMP_NTZ holding LOCAL wall-clock time.
--      Before running 05_seed.sql (and in any worksheet that calls the
--      procedures), set the session time zone to the laptop's IANA zone:
--        -- ALTER SESSION SET TIMEZONE = 'America/Los_Angeles';
--      The API does the same with PIP_TIMEZONE.
--
-- Enumerations are documented in column COMMENTs (Snowflake does not enforce
-- CHECK constraints). PRIMARY KEY constraints are informational only.
-- Column clauses follow the documented CREATE TABLE grammar order:
-- type, NOT NULL, DEFAULT, COMMENT (COMMENT is last).
-- DEFAULT CURRENT_TIMESTAMP() is cast to TIMESTAMP_NTZ because a TIMESTAMP_LTZ
-- default on an NTZ column is rejected ("Default value data type does not match").
-- =============================================================================

CREATE WAREHOUSE IF NOT EXISTS PIP_WH
  WAREHOUSE_SIZE = 'XSMALL'
  AUTO_SUSPEND = 300
  AUTO_RESUME = TRUE
  INITIALLY_SUSPENDED = TRUE;

CREATE DATABASE IF NOT EXISTS PIP;
CREATE SCHEMA IF NOT EXISTS PIP.APP;

USE WAREHOUSE PIP_WH;
USE DATABASE PIP;
USE SCHEMA APP;

-- -----------------------------------------------------------------------------
-- STUDENTS
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS PIP.APP.STUDENTS (
  student_id VARCHAR NOT NULL DEFAULT UUID_STRING(),
  created_at TIMESTAMP_NTZ NOT NULL DEFAULT CURRENT_TIMESTAMP()::TIMESTAMP_NTZ,
  PRIMARY KEY (student_id)
)
COMMENT = 'One row per student. The demo student id is ''demo''.';

-- -----------------------------------------------------------------------------
-- TIMETABLE: the fixed weekly blocks (classes, labs, shifts)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS PIP.APP.TIMETABLE (
  student_id  VARCHAR NOT NULL,
  day_of_week NUMBER(1,0) NOT NULL COMMENT 'ISO day of week: 1 = Monday ... 7 = Sunday (DAYOFWEEKISO)',
  title       VARCHAR NOT NULL,
  starts_at   TIME NOT NULL,
  ends_at     TIME NOT NULL,
  location    VARCHAR
)
COMMENT = 'Weekly fixed blocks. PUT /timetable replaces all rows of a student.';

-- -----------------------------------------------------------------------------
-- PROFILE
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS PIP.APP.PROFILE (
  student_id        VARCHAR NOT NULL,
  chronotype        VARCHAR NOT NULL DEFAULT 'neutral' COMMENT 'early_bird | neutral | night_owl',
  cooks_own_meals   BOOLEAN NOT NULL DEFAULT TRUE,
  cash_available    NUMBER(10,2) NOT NULL DEFAULT 0,
  budget_until      DATE,
  procrastinates_on VARCHAR COMMENT 'category or NULL: class | assignment | errand | meal | money | work | club | social | rest',
  updated_at        TIMESTAMP_NTZ NOT NULL DEFAULT CURRENT_TIMESTAMP()::TIMESTAMP_NTZ,
  PRIMARY KEY (student_id)
);

-- -----------------------------------------------------------------------------
-- CAPTURES: one row per spoken or typed dump
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS PIP.APP.CAPTURES (
  capture_id       VARCHAR NOT NULL DEFAULT UUID_STRING(),
  student_id       VARCHAR NOT NULL,
  audio_stage_path VARCHAR COMMENT 'path inside @PIP.APP.AUDIO_STAGE, NULL for text captures',
  transcript       VARCHAR NOT NULL,
  source           VARCHAR NOT NULL DEFAULT 'text' COMMENT 'voice | text',
  created_at       TIMESTAMP_NTZ NOT NULL DEFAULT CURRENT_TIMESTAMP()::TIMESTAMP_NTZ,
  PRIMARY KEY (capture_id)
);

-- -----------------------------------------------------------------------------
-- TASKS
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS PIP.APP.TASKS (
  task_id         VARCHAR NOT NULL DEFAULT UUID_STRING(),
  student_id      VARCHAR NOT NULL,
  capture_id      VARCHAR COMMENT 'capture that created or last touched the task',
  raw_text        VARCHAR NOT NULL,
  normalized_text VARCHAR NOT NULL,
  category        VARCHAR NOT NULL COMMENT 'class | assignment | errand | meal | money | work | club | social | rest',
  due_at          TIMESTAMP_NTZ COMMENT 'local wall time',
  money_at_risk   NUMBER(10,2),
  est_minutes     NUMBER(6,0),
  status          VARCHAR NOT NULL DEFAULT 'open' COMMENT 'open | done | deferred | dropped | expired',
  defer_count     NUMBER(6,0) NOT NULL DEFAULT 0,
  created_at      TIMESTAMP_NTZ NOT NULL DEFAULT CURRENT_TIMESTAMP()::TIMESTAMP_NTZ,
  PRIMARY KEY (task_id)
);

-- -----------------------------------------------------------------------------
-- CONSTRAINTS: facts extracted from a capture that are not tasks
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS PIP.APP.CONSTRAINTS (
  constraint_id VARCHAR NOT NULL DEFAULT UUID_STRING(),
  capture_id    VARCHAR NOT NULL,
  kind          VARCHAR NOT NULL COMMENT 'time_window | cash | fixed_block | travel',
  value         VARIANT COMMENT 'time_window {minutes} | cash {amount, until} | fixed_block {title, starts_at, ends_at, location} | travel {minutes, to}',
  created_at    TIMESTAMP_NTZ NOT NULL DEFAULT CURRENT_TIMESTAMP()::TIMESTAMP_NTZ,
  PRIMARY KEY (constraint_id)
);

-- -----------------------------------------------------------------------------
-- DECAY_CONFIG: cost-of-delay curve per category
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS PIP.APP.DECAY_CONFIG (
  category        VARCHAR NOT NULL,
  curve           VARCHAR NOT NULL COMMENT 'cliff | linear | daily_reset | rising_floor | defer_multiplier',
  half_life_hours NUMBER(6,1) NOT NULL,
  floor_weight    NUMBER(4,2) NOT NULL,
  PRIMARY KEY (category)
);

-- -----------------------------------------------------------------------------
-- PLANS: append-only; every capture and every rerank adds one row
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS PIP.APP.PLANS (
  plan_id    VARCHAR NOT NULL DEFAULT UUID_STRING(),
  student_id VARCHAR NOT NULL,
  capture_id VARCHAR,
  do_now     VARIANT COMMENT 'PlanItem or null',
  next       VARIANT COMMENT 'PlanItem or null',
  today      VARIANT COMMENT 'PlanItem[]',
  can_wait   VARIANT COMMENT 'PlanItem[]',
  reasoning  VARIANT COMMENT 'PlanReasoning (api/src/types.ts)',
  model      VARCHAR NOT NULL COMMENT 'claude-sonnet-4-5 | mistral-large2 | llama3.1-8b | sql-prerank | deterministic-ranker-v1',
  created_at TIMESTAMP_NTZ NOT NULL DEFAULT CURRENT_TIMESTAMP()::TIMESTAMP_NTZ,
  PRIMARY KEY (plan_id)
)
COMMENT = 'Append-only plan history. Never UPDATE or DELETE rows.';

-- -----------------------------------------------------------------------------
-- ACTIONS: what the student did with a plan
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS PIP.APP.ACTIONS (
  action_id  VARCHAR NOT NULL DEFAULT UUID_STRING(),
  student_id VARCHAR NOT NULL,
  plan_id    VARCHAR NOT NULL,
  task_id    VARCHAR,
  kind       VARCHAR NOT NULL COMMENT 'start_now | done | defer | drop',
  created_at TIMESTAMP_NTZ NOT NULL DEFAULT CURRENT_TIMESTAMP()::TIMESTAMP_NTZ,
  PRIMARY KEY (action_id)
);

-- -----------------------------------------------------------------------------
-- PIVOT_LOG: hackathon pivot journal
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS PIP.APP.PIVOT_LOG (
  entry_id           VARCHAR NOT NULL DEFAULT UUID_STRING(),
  pivot_number       NUMBER(3,0) NOT NULL,
  revealed           VARCHAR NOT NULL,
  assumption_changed VARCHAR NOT NULL,
  response           VARCHAR NOT NULL,
  cut                VARCHAR NOT NULL,
  sentence           VARCHAR,
  created_at         TIMESTAMP_NTZ NOT NULL DEFAULT CURRENT_TIMESTAMP()::TIMESTAMP_NTZ,
  PRIMARY KEY (entry_id)
);

-- -----------------------------------------------------------------------------
-- CORTEX_CONFIG: which Cortex functions/models work on this account
-- keys: complete_fn | complete_model | embed_fn | transcribe_fn
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS PIP.APP.CORTEX_CONFIG (
  key         VARCHAR NOT NULL COMMENT 'complete_fn | complete_model | embed_fn | transcribe_fn',
  value       VARCHAR COMMENT 'e.g. AI_COMPLETE | SNOWFLAKE.CORTEX.COMPLETE | claude-sonnet-4-5 | AI_EMBED | AI_TRANSCRIBE; NULL = unavailable',
  verified_at TIMESTAMP_NTZ
)
COMMENT = 'Written by the verification block in 03_functions.sql and by the API /health check; read by the procedures.';

SHOW TABLES IN SCHEMA PIP.APP;

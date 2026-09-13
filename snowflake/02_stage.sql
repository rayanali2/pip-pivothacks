-- =============================================================================
-- UniMate / Snowflake layer  --  02_stage.sql
-- Internal stage for voice captures (m4a) uploaded by the API.
-- AI_TRANSCRIBE only reads files from stages with SERVER-SIDE encryption
-- (SNOWFLAKE_SSE). The default client-side encryption does not work, and the
-- encryption type of an existing stage cannot be changed: if you created
-- AUDIO_STAGE earlier without SNOWFLAKE_SSE, DROP STAGE PIP.APP.AUDIO_STAGE first.
-- =============================================================================

USE WAREHOUSE PIP_WH;
USE SCHEMA PIP.APP;

CREATE STAGE IF NOT EXISTS PIP.APP.AUDIO_STAGE
  ENCRYPTION = (TYPE = 'SNOWFLAKE_SSE')
  DIRECTORY = (ENABLE = TRUE)
  COMMENT = 'Voice captures. Path convention: <student_id>/<capture_id>.m4a';

-- Examples (PUT works from SnowSQL / snowflake-sdk, not from a Snowsight worksheet):
--   PUT file:///tmp/demo.m4a @PIP.APP.AUDIO_STAGE/demo/ AUTO_COMPRESS = FALSE OVERWRITE = TRUE;
--   LIST @PIP.APP.AUDIO_STAGE;
--   ALTER STAGE PIP.APP.AUDIO_STAGE REFRESH;   -- refresh the directory table
--   SELECT AI_TRANSCRIBE(TO_FILE('@PIP.APP.AUDIO_STAGE', 'demo/demo.m4a')):text::STRING;
-- AUTO_COMPRESS = FALSE matters: a gzipped .m4a.gz cannot be transcribed.

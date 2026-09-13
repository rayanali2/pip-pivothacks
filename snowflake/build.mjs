// Builds snowflake/03_functions.sql from snowflake/src/*.
//   node snowflake/build.mjs
// Each JavaScript procedure body = common.js + its own sources. The build
// syntax-checks every body (wrapped in a function, as Snowflake does) and
// refuses bodies that contain the $$ delimiter.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = (f) => readFileSync(join(here, 'src', f), 'utf8');

const procedures = [
  {
    title: '(d) EXTRACT_FROM_TRANSCRIPT',
    signature: 'PIP.APP.EXTRACT_FROM_TRANSCRIPT(CAPTURE_ID VARCHAR)',
    args: ['CAPTURE_ID'],
    files: ['common.js', 'extract.js'],
  },
  {
    title: '(e) BUILD_PLAN',
    signature: 'PIP.APP.BUILD_PLAN(STUDENT_ID VARCHAR, CAPTURE_ID VARCHAR, EXTRA_CONTEXT VARIANT)',
    args: ['STUDENT_ID', 'CAPTURE_ID', 'EXTRA_CONTEXT'],
    files: ['common.js', 'plan_core.js', 'plan_llm.js', 'plan_proc.js'],
  },
  {
    title: '(f) RECORD_ACTION',
    signature: 'PIP.APP.RECORD_ACTION(STUDENT_ID VARCHAR, PLAN_ID VARCHAR, TASK_ID VARCHAR, KIND VARCHAR)',
    args: ['STUDENT_ID', 'PLAN_ID', 'TASK_ID', 'KIND'],
    files: ['common.js', 'record_action.js'],
  },
];

let out = src('03_head.sql').replace(/\s+$/, '') + '\n';
for (const p of procedures) {
  const body = p.files.map((f) => `// ===== ${f} =====\n` + src(f).replace(/\s+$/, '')).join('\n\n');
  if (body.includes('$$')) throw new Error(`${p.title}: body contains $$`);
  // Syntax check (Snowflake wraps the body in a function, so top-level return is legal).
  new Function('snowflake', ...p.args, body);
  out += `
-- -----------------------------------------------------------------------------
-- ${p.title}
-- -----------------------------------------------------------------------------
CREATE OR REPLACE PROCEDURE ${p.signature}
RETURNS VARIANT
LANGUAGE JAVASCRIPT
EXECUTE AS CALLER
AS
$$
${body}
$$;
`;
}
out += `
SHOW PROCEDURES IN SCHEMA PIP.APP;
`;
writeFileSync(join(here, '03_functions.sql'), out.replace(/\r\n/g, '\n'));
console.log('wrote snowflake/03_functions.sql (' + out.length + ' chars)');

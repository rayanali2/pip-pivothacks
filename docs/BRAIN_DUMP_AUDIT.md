# Brain-dump isolation audit — 2026-09-13

## Findings and changes

- iOS used the shared `demo` student ID, so every capture saw the persisted six demonstration tasks. The app now generates a stable installation-specific student ID. This is data partitioning, not authentication; a production multi-user deployment still needs authenticated identity on the server.
- MemoryBackend seeded the same tasks, class timetable and $35 profile for every student. Only the explicitly named `demo` identity is now seeded. New students start with no tasks or timetable.
- OfflineService replaced arbitrary text with a saved demo plan. The service router and fixture loader now require the explicit `--pip-demo` launch argument in a Debug build. Release builds always use the API. An old UserDefaults demo preference cannot activate fixtures. Normal mode reports that the server is unavailable instead of returning example tasks, retries the API on the next request, and keeps failed typed submissions in the input field.
- The fixture-based context panel, context history, pivot log, demo sentence, reset button, and timer skip are gated on that same demo flag. `/context/*` remains an explicit demo API, not a general Snowflake planner.
- Mock voice without a transcript previously pretended to hear the demo sentence. Non-demo callers now receive `needs_text: true` and an empty transcript.
- Follow-up captures previously skipped extraction and ignored newly mentioned tasks. Live and memory follow-ups now extract tasks/constraints, keep existing tasks, and rerank. The iOS typed follow-up bar now uses the capture endpoint with `followup_plan_id`, like voice, so new tasks reach extraction; time-only slider reranks and previews remain on the rerank endpoint. A successful Cortex extraction of zero tasks is accepted as empty rather than treated as a parser failure.
- Both backend modes now default to real time; freezing the clock requires an explicit `DEMO_NOW=HH:MM`. Student-specific GET routes require a nonempty student ID instead of defaulting to demo. Demo wording also requires the explicit demo identity. Local server configuration uses `DEMO_NOW=real`. The ignored `.env` and credentials are not part of this change.

## Live Snowflake checks

Used new `audit-*` student IDs, with the actual Snowflake procedures and real clock. No seeded tasks or timetable were copied to those students.

| Input | Observed top task | Result |
| --- | --- | --- |
| Biology essay tomorrow morning, professor email tonight, bookshelf this weekend | Email professor | Correct earlier deadline; 3 matching tasks |
| Parking permit due tonight with $120 fine, paper tomorrow, cousin call at weekend | Renew parking permit | Correct irreversible loss; 3 matching tasks |
| Client proposal tomorrow noon, vet booking tomorrow, guitar at weekend | Send client proposal | Correct priority; 3 matching tasks |
| Greeting with no tasks | No task | Empty task list; no invented work |
| Follow-up adding electricity bill due tonight with $80 fee | Pay electricity bill | Existing work tasks retained; new task added and ranked first |

All five returned `source: snowflake`. Nonempty plans used Cortex Claude Sonnet 4.5 wording over Snowflake SQL pre-ranking. The empty plan used SQL pre-ranking without LLM wording. Assertions checked student/task isolation, planned task IDs, no headphones/CHEM 110/CS 101 leakage, and follow-up linkage.

The first academic assertion incorrectly expected the essay ahead of the email due tonight; it was corrected and the entire live audit rerun successfully.

## Reproduction and scope

From `api/`: `npm ci`, `npm run build`, `npm test`. With the live server running on localhost:3000, `node tools/audit-brain-dumps.cjs` creates isolated audit rows and writes raw results to ignored `api/tmp/`. It invokes paid Cortex calls. The current relative-time cases are intended for a daytime/evening run before 10 PM; priority expectations must be adjusted if deadlines have already passed.

New automated tests cover empty initial state, cross-student/demo isolation, question-only input, missing audio transcription and adding a task in a follow-up. Existing tests cover rank rules, time zones, parsing, HTTP routes, pipeline tracing, mocked live failures, Claude output validation, and context demos.

This finite set does not prove perfect understanding of every possible input. No real microphone recording was tested. iOS identity/offline changes require a Mac/iPhone build. Unknown cash still defaults to zero in the current profile contract. Existing unfinished tasks for the same real student intentionally remain across brain dumps; the tests do not delete or replace them. Cloud authentication and cross-device identity are outside this patch.

## App completion checks

- `npm run build`: passed. `npm test`: 96 tests across 10 files passed. Vitest required running outside the Windows filesystem sandbox to load esbuild configuration.
- Restarted the local API from the updated build. Health reports live mode, a real clock, and Snowflake connected. A GET `/history` without identity returns 400.
- A second live audit passed errands, work, empty-input, and new-task follow-up cases through Snowflake. The academic case timed out and returned a clearly marked deterministic fallback using only its three submitted tasks, with no demo leakage. Its priority differed from the Cortex result, so the full live audit correctly exited with a failure rather than hiding the timeout. Raw results are in ignored `api/tmp/`.
- Mac/device checks still required: launch normally and confirm no seed plan/classes/history; type unrelated tasks; add a new task through Today; disconnect the server and confirm no fixture substitution and typed input retained; reconnect and retry; confirm Release builds cannot enable demo mode. Compile/open `ios/Pip/Pip.xcodeproj` on a Mac. Windows has neither Xcode nor Swift installed.
- Retried only the failed academic case with a fresh identity: passed through Snowflake, extracted the three matching tasks, and ranked Email professor first. Saved as ignored `api/tmp/audit-academic-retry.json`. The original timeout result remains recorded.

# UniMate for Chrome

UniMate in Chrome's side panel, matching the iPhone app's design and features. It is plain HTML, CSS and ES modules, so there is no build step. It needs Chrome 116 or newer.

## Run it

1. From the repository's `api` folder, run `npm run dev` and leave it running.
2. In Chrome, open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and select this `extension` folder (not the repository root).
4. Pin UniMate from Chrome's extensions menu, then click it to open the side panel.

After changing files, click the reload icon on UniMate's card in `chrome://extensions` and reopen the panel.

The API address defaults to `http://localhost:3000`. You can change the port under **Schedule → Server**.

## What matches the app

| iPhone app | Chrome extension |
|---|---|
| **UniMate tab:** Now / Next class / Free strip, the animated penguin, hold-to-talk mic, typed input, pipeline reveal, do-now card, Up next, editable "Your words" | Same. You can hold the mic to talk, or tap once to start and tap again to send. |
| **Do-now stakes:** live countdown, cost-of-waiting sparkline, the 5 rule chips, "What if this takes 10 min longer?" preview | Same |
| **Today tab:** free-window header, What changed, focus card with window fit, risk alerts, plan notes, the day timeline (Now line, "Doesn't fit" tray, Full window / 48 min / 25 min), Can wait, follow-up bar with chips and voice | Same. Timeline cards glide to their new places after a rerank. |
| **Task detail:** facts, ranking evidence, cost curve, Done / Defer / Drop, original capture | Same |
| **Focus timer:** ring, +10 min, Done early, Time is up, I'm stuck | Same. The Live Activity becomes a minutes-left badge on the toolbar icon plus a Chrome notification when time is up. |
| **Save & reminders:** Apple Calendar, Google Calendar, local reminders | Google Calendar opens in a tab. Apple and Outlook get a `.ics` download. Reminders fire as Chrome notifications. |
| **Schedule tab:** today's timeline with filters, No time yet, the week (add and delete blocks), Money & routine, Server health | Same |
| **History tab:** decisions with an actions filter; Pivot Log in demo mode | Same |
| ElevenLabs voice from the API's `/speech` (device voice as fallback), beak moving while it talks, mute | Same: ElevenLabs audio when `ELEVENLABS_API_KEY` is set on the API, otherwise Chrome's built-in voices |
| Per-install student ID; the shared `demo` student only with `--pip-demo` | Per-install student ID. The `demo` student only when **Schedule → Server → Developer demo** is on. |

Only in Chrome: **Scan this tab** reads the course page you have open, but only when you click it. It sends the lines with dates and deadlines to UniMate as a capture.

Not ported: the Pivot 3 "context check" demo screens, which only exist in the app's developer demo mode.

## Voice

The first time you hold the mic, Chrome opens a small tab asking for microphone access. The side panel can't show that prompt itself. Allow it, then hold the mic again.

UniMate sends two things with each recording:
- the audio file (WebM)
- the words Chrome recognised, as `client_transcript`

The `client_transcript` works like the iPhone's on-device transcript. If Snowflake can't transcribe the audio, the API uses those words instead, so voice works in both mock and live mode.

## Data and permissions

- **`sidePanel`, `storage`:** run the panel and save its settings.
- **`activeTab`, `scripting`:** Scan this tab. UniMate reads a page only when you click the button.
- **`alarms`, `notifications`:** focus timer and reminders.
- **Host access:** only `localhost` and `127.0.0.1`.

What is stored where:
- Your current plan is kept in session storage.
- The student ID, API address, mute setting, reminders and a running focus timer are kept in local storage.

Snowflake secrets stay in `api/.env`. Never copy it into this folder.

This is a local development extension. The backend has no authentication, so don't expose the API publicly.

## Manual smoke test

- Type a day and send. The pipeline stages reveal one by one, then the do-now card appears with a ticking countdown, and UniMate speaks.
- Hold the mic, talk, and release. The plan updates.
- On Today, switch the timeline to 25 min. The What changed banner appears, cards glide, and an item lands in "Doesn't fit".
- Tap **What if this takes 10 min longer?** A preview appears and the plan stays unchanged.
- Tap **Start now**. The focus timer opens and the toolbar badge shows minutes left. **Skip to end** (demo mode) triggers the notification.
- Open a task, then tap **Done**. History shows the action.
- Add and delete a class on Schedule, then save Money & routine.
- Add a reminder a minute ahead. A Chrome notification fires.
- Stop the API and try to send. A banner explains that the server is unreachable.

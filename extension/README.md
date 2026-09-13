# Pip for Chrome

Load this directory directly as an unpacked Manifest V3 extension; no frontend build or dependencies are required. Chrome 116+ is required for the side panel. Voice uses WebM/Opus where Chrome supports it, with MP4/AAC as a fallback. Typed input is always available.

1. From the repository's `api` folder, run `npm run dev`. Keep this running.
2. In Chrome open `chrome://extensions` and enable Developer mode.
3. Click **Load unpacked** and select this repository's `extension` directory.
4. Pin Pip from Chrome's extensions menu, then click Pip to open the side panel.
5. Confirm “Snowflake connected” or “Local fallback”, type a day, and click **Find my next step**.

The API defaults to http://localhost:3000. Change its local port under History → Connection settings. The existing `demo` student is used. Mock mode is provided by the API (`MOCK_MODE=true`); an unreachable server is reported as offline, not silently replaced with fabricated plans.

## Included

Text-to-plan, optional recording with audio preview and explicit upload, current-tab course-page scan, spoken recommendations with mute, Today/Next/Can wait sections, evidence details, 25-minute and minus-10-minute reranks, free-text follow-ups, Start/Done/Later actions, complete prompt/response history, weekly schedule display and class addition, budget editing, and connection diagnostics.

Voice recording requires microphone approval. No audio is sent until **Send recording to Pip**. If Chrome or Snowflake cannot process audio, use typed input. The “10 minutes less time” control reduces total available time; it does not implement the separate named-travel-segment Pivot 03 simulation.

## Data and permissions

The extension uses `sidePanel`, `storage`, `activeTab`, and `scripting`, plus HTTP host access limited to localhost and 127.0.0.1. It can read the current page only after **Scan this tab** is clicked. It does not read browsing history or scan tabs in the background. Plan state is held in session storage; a 50-entry conversation journal, the local API address, and mute preference persist locally. Snowflake secrets remain exclusively in `api/.env`. Do not copy the `.env` into this directory.

This is a local development extension. The existing backend has no user authentication, so it must not be exposed publicly as a shared service. A deployed multi-user version needs backend authentication and student isolation before public distribution. Load unpacked from this folder only, never the repository root.

## Manual smoke test

- Create a typed plan; confirm all sections and evidence appear.
- Open an HTML course outline, click **Scan this tab**, and confirm dated course work appears in the returned plan.
- Submit at least two prompts and one follow-up; confirm all three appear under History after a refresh.
- Rerank to 25 minutes; confirm the returned change headline appears.
- Start a task; open History and verify the action.
- Save a budget, add a class, and verify them after Refresh.
- Toggle speech; test record, stop, preview, and explicit upload on a microphone-capable Chrome installation.
- Stop the API and Refresh: the panel should show API offline and preserve the current visible plan.

No credentials or external assets are packaged. The penguin is original CSS artwork.

# webex-meeting-join

Self-contained OpenClaw plugin: auto-joins Webex space meetings (instant and
scheduled) via the real Webex Browser SDK when they start, and leaves on a
chat command ("leave meeting"). No dependency on any other OpenClaw plugin or
the `lib` workspace — copy this folder to another OpenClaw instance, set the
env vars below, and it runs.

Phase 1 scope only: **join and leave**. No transcription (native or
Deepgram) — that's phase 2, and will need to revisit `browser-entry.js`'s
media handling (see "Known limitations" below).

## How it works (Approach 2 from the research phase)

1. This plugin registers its own Webex webhooks: `meetings/started`,
   `meetings/ended` (owned by the dedicated meeting account), and
   `messages/created` (owned by the bot account).
2. When a `meetings/started` webhook fires, it resolves the meeting's
   `meetingId`/`sipUrl` via REST, confirms the meeting account is a member of
   the associated space, and drives a headless Chromium instance (via
   Playwright) that hosts the actual `@webex/plugin-meetings` SDK to call
   `webex.meetings.create()` + `meeting.join()`.
3. A user typing "leave meeting" (or `/meeting leave`) in the space —
   addressed to the bot via @mention in a group space, or any message in a
   1:1 — triggers `meeting.leave()` and a suppression flag so the bot won't
   auto-rejoin that same meeting instance.
4. A startup reconciliation sweep + a periodic poll (default every 5
   minutes) catch any meeting the `started` webhook missed.

## Required environment variables

| Variable | Purpose |
|---|---|
| `WEBEX_BOT_TOKEN` | Bot identity — posts chat messages, owns the `messages/created` webhook |
| `WEBEX_MEETING_ACCESS_TOKEN` (or falls back to `WEBEX_ACCESS_TOKEN`) | Dedicated human-user account that actually joins meetings (bot accounts cannot) |
| `WEBEX_MEETING_WEBHOOK_URL` | Public base URL this plugin's own webhook route is reachable at, e.g. `https://your-domain/webhooks/webex-meeting-join` |

Optional (enable proactive + reactive OAuth token refresh for the meeting
account — falls back to `WEBEX_REFRESH_TOKEN`/`WEBEX_CLIENT_ID`/
`WEBEX_CLIENT_SECRET` if unset):
`WEBEX_MEETING_REFRESH_TOKEN`, `WEBEX_MEETING_CLIENT_ID`,
`WEBEX_MEETING_CLIENT_SECRET`.

Optional tuning: `WEBEX_WEBHOOK_SECRET` (HMAC verification, shared with the
main webex plugin's secret is fine), `WEBEX_MEETING_POLL_INTERVAL_MS`
(default 300000), `WEBEX_MEETING_JOIN_TIMEOUT_MS` (default 20000).

## Porting to another OpenClaw instance

1. Copy this folder.
2. Add its path to that instance's `plugins.load.paths` and an entry under
   `plugins.entries` in `config/openclaw.json` (id: `webex-meeting-join`).
3. Add `"plugins/webex-meeting-join"` to the root `package.json` workspaces
   array (it has its own npm dependencies — `@webex/plugin-meetings` and its
   direct dependencies, `playwright`, `esbuild` — so it must be a workspace
   member; a dependency-free plugin wouldn't need this).
4. Set the env vars above.
5. `npm install --workspaces`. Headless Chromium must be available — reuses
   the shared `PLAYWRIGHT_BROWSERS_PATH` cache if another workspace already
   installed it (this repo's `lib` does), otherwise run
   `npx playwright install --with-deps chromium` once.

## Known limitations / what's still unverified

Everything in `browser-entry.js`/`browser-runtime.js` runs the real Webex SDK
in a real headless Chromium page — it was bundle-tested and loaded
successfully with `esbuild` + `esbuild-plugin-polyfill-node`, and smoke-tested
in an actual headless browser (confirmed `window.__webexMeetingJoin` exposes
`init`/`join`/`leave`/`syncActive` and the bundle no longer throws at
load-time). It was **not** exercised against a real Webex meeting/token —
no live account was available in this environment. Calling `init()` with a
placeholder token gets past module loading and into the SDK's own
`meetings.register()` flow, then fails inside an internal metrics call
(`Metrics2.sendBehavioralMetric` reading `.internal` off something
undefined) — consistent with device registration silently failing on an
invalid token before a telemetry call assumes it succeeded. If this exact
error recurs with a **real** token, it points to an SDK init-sequencing gap
(e.g. needing to await device/mercury registration before calling
`meetings.register()`) rather than a bundling problem — that's the concrete
next debugging step, not a full unknown.

`meeting.join()` is called without `meeting.addMedia()` — no audio/video
track is ever requested, so the join is presence-only for phase 1. Whether
Webex's Locus signaling accepts a no-media join the same way a real client
would is itself unverified against a live meeting.

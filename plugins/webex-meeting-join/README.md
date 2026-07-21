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
   normal attendee-facing HTTPS `webLink` via REST (falling back to the
   meeting ID or SIP address only if Webex omitted that link), confirms the
   meeting account is a member of the associated space, and drives a headless
   Chromium instance (via Playwright) that hosts the actual
   `@webex/plugin-meetings` SDK to call `webex.meetings.create()` +
   `meeting.join()`.
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

## Known limitations / verification

`browser-entry.js`/`browser-runtime.js` runs the real Webex SDK in headless
Chromium. The bundle is smoke-tested in Chromium, and SDK readiness plus
device/Mercury registration have been verified against a live meeting-account
token. Initialization waits for `meetings:ready` before calling
`meetings.register()`; calling it earlier races the SDK's metrics and device
setup and causes the `.internal`/`setDeviceInfo` TypeErrors.

The page uses an in-memory `http://openclaw.local` document. A bare Playwright
page has a `null` origin, which Webex rejects during CORS preflight for U2C and
Hydra and eventually surfaces as a preauth-catalog timeout.

If Webex commits the Locus join but its SDK response/interceptor still rejects,
the plugin waits for Mercury and performs one meeting sync before deciding the
join failed. It accepts the join only when Locus reports `JOINED` for the
registered browser device itself; another client using the same meeting account
cannot produce a false success.

`meeting.join()` is intentionally called without `meeting.addMedia()` — the
Webex SDK documents this as joining without media. No audio/video track is
requested in phase 1; transcription will require adding receive-media handling
in phase 2.

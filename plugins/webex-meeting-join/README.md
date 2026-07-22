# webex-meeting-join

Self-contained OpenClaw plugin: auto-joins Webex space meetings (instant and
scheduled) via the real Webex Browser SDK when they start, and leaves on a
chat command ("leave meeting"). No dependency on any other OpenClaw plugin or
the `lib` workspace — copy this folder to another OpenClaw instance, set the
env vars below, and it runs.

Scope: **join, leave, and listen**. On join the bot now subscribes to the
meeting's audio (receive-only — no microphone, camera, or screen share is
published) and logs whether that audio is audible. It does **not** yet forward
audio anywhere: real-time transcription (Deepgram) and a proactive agent reply
in the originating space are the next step, and the subscribed `MediaStream` in
`audio-monitor.js` is the seam they'll consume (see "Audio subscription" and
"Known limitations" below).

## How it works (Approach 2 from the research phase)

1. This plugin registers its own Webex webhooks: `meetings/started`,
   `meetings/ended` (owned by the dedicated meeting account), and
   `messages/created` (owned by the bot account).
2. When a `meetings/started` webhook fires, it resolves the meeting's
   SDK-facing REST `sipUrl`/`sipAddress` (falling back to the meeting ID),
   confirms the meeting account is a member of the associated space, and
   drives a headless Chromium instance (via Playwright) that hosts the actual
   `@webex/plugin-meetings` SDK to call `webex.meetings.create()` +
   `meeting.join()`.
3. A user typing "leave meeting" (or `/meeting leave`) in the space —
   addressed to the bot via @mention in a group space, or any message in a
   1:1 — asks the SDK for its authenticated Locus leave request, dispatches
   that request from the Node host (outside browser CORS), and sets a
   suppression flag so the bot won't auto-rejoin that same meeting instance.
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
(default 300000), `WEBEX_MEETING_JOIN_TIMEOUT_MS` (default 20000),
`WEBEX_MEETING_BROWSER_EXECUTABLE` (path to an H264-capable Chromium-based
browser — see "Browser choice: the H264 requirement" below; when unset the
runtime auto-detects Brave and otherwise falls back to Playwright's Chromium).

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

The Locus participant-leave `PUT` is dispatched by the Node host using the
request produced by the SDK's public `meeting.buildLeaveFetchRequestOptions()`
API. This is the same request used by `meeting.leave()`, but it is not subject
to the synthetic page origin's CORS policy. The runtime accepts only HTTPS
`*.wbx2.com` participant-leave endpoints and reports the actual Locus HTTP
status/body if Webex rejects the operation.

If Webex commits the Locus join but its SDK response/interceptor still rejects,
the plugin waits for Mercury and synchronizes twice before deciding the join
failed. It accepts the join only when the SDK reports `JOINED` for the
registered browser device itself; another client using the same meeting account
cannot produce a false success.

## Audio subscription

`meeting.join()` is signalling-only; audio is attached separately, right after
the join succeeds, via `meeting.addMedia({ audioEnabled: true, videoEnabled:
false, additionalMediaOptions: { sendAudio: false, receiveVideo: false } })`.
That negotiates a **receive-only** audio direction: the bot hears the meeting
but never publishes a microphone, camera, or screen-share track.

Because the join negotiates transcoded (non-multistream) media, the remote
audio of every participant arrives as a single mixed `MediaStream` on the SDK's
`media:ready` event (`type: 'remoteAudio'`). `audio-monitor.js` runs that stream
through a WebAudio `AnalyserNode` (routed to a muted gain node so samples flow in
headless Chromium without emitting sound) and logs on the rising edge when the
audio becomes audible, a throttled heartbeat while it stays audible, and when it
goes quiet. Those page-side logs reach the Node logger through the
`__openclawMeetingAudioLog` binding exposed in `browser-runtime.js`.

`addMedia()` is fire-and-forget from within `join()`: ICE/TURN negotiation can
take several seconds and would otherwise count against the join timeout, so a
media hiccup can never evict an otherwise-successful join. The monitor is torn
down on leave and on `dispose()`.

**Next step (Deepgram):** the same `MediaStream` handed to the level meter is
where a real-time transcription client will tap in, so the agent can respond
proactively in the Webex space the meeting originated from. Nothing forwards
audio off-box today.

### Browser choice: the H264 requirement

The Webex SDK hardcodes `requireH264: true` and `skipInactiveTransceivers:
false` for its transcoded media connection, so `addMedia()` validates that the
local SDP's video m-line offers H264 **even for our audio-only, receive-only
subscription** — there is no SDK option to skip it. Playwright's stock
Chromium ships without proprietary codecs on Linux (and no arm64 Google
Chrome build exists to substitute), which surfaces as:

    could not subscribe to meeting audio: H264 codec is missing for video media description with mid=1

Fix: launch a Chromium-based browser that bundles H264. The runtime resolves
one in this order: `WEBEX_MEETING_BROWSER_EXECUTABLE` if set (must exist —
fails loudly rather than degrading), else auto-detected Brave
(`/usr/bin/brave-browser` and friends — already installed in the deployment
image), else Playwright's Chromium with a logged warning (join/leave still
work; only the audio subscription needs H264).

Profile isolation: Playwright's `chromium.launch()` always creates a fresh
ephemeral user-data-dir per launch, so this Brave instance never opens — or
contends on the `SingletonLock` of — the gateway's managed Brave profile,
even though both run the same binary in the same container.

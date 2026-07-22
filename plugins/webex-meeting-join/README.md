# webex-meeting-join

Self-contained OpenClaw plugin: auto-joins Webex space meetings (instant and
scheduled) via the real Webex Browser SDK when they start, leaves on a chat
command ("leave meeting"), and — when a Deepgram key is configured — transcribes
the meeting in real time and posts proactive interventions into the meeting's
Webex space.

Scope: **join, leave, listen, and (optionally) transcribe + intervene**. On join
the bot subscribes to the meeting's audio (receive-only — no microphone, camera,
or screen share is published). It always logs whether that audio is audible; and
when `DEEPGRAM_API_KEY` is set it additionally streams the audio to Deepgram's
turn-based (Flux) API, runs each completed speaker turn through the **same
proactivity gate the webex chat plugin uses**, and posts a short agent reply to
the space when the gate says it's worth it. See "Audio subscription" and
"Real-time transcription & proactive interventions" below. With no Deepgram key
the plugin behaves exactly as before and no audio leaves the browser.

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

Optional transcription (all no-ops unless `DEEPGRAM_API_KEY` is set):

| Variable | Purpose | Default |
|---|---|---|
| `DEEPGRAM_API_KEY` | Enables real-time transcription + proactive interventions. | (unset → off) |
| `DEEPGRAM_BASE_URL` | Override the Deepgram endpoint (proxy / self-hosted). | `https://api.deepgram.com` |
| `WEBEX_MEETING_DEEPGRAM_MODEL` | Deepgram Flux model. | `flux-general-en` |
| `WEBEX_MEETING_EOT_THRESHOLD` | Flux end-of-turn confidence threshold (0–1). | `0.7` |
| `WEBEX_MEETING_EOT_TIMEOUT_MS` | Flux end-of-turn silence timeout. | `5000` |
| `WEBEX_MEETING_MIN_TURN_WORDS` | Skip turns shorter than this before gating (turns naming the assistant are exempt). | `5` |
| `WEBEX_MEETING_GATE_THRESHOLD` | Gate score (0–1) a turn must clear to intervene. | `0.7` |
| `WEBEX_MEETING_ADDRESSED_GATE_THRESHOLD` | Lower gate score for turns the gate classifies as `ADDRESSED` (a participant spoke to the assistant by name). | `0.45` |

The gate LLM itself reuses the webex chat plugin's proactivity gate and its
`CISCO_LLM_API_KEY` / `channels.webex.proactivity.gate` config — no extra key is
needed for the intervention decision.

## Porting to another OpenClaw instance

1. Copy this folder.
2. Add its path to that instance's `plugins.load.paths` and an entry under
   `plugins.entries` in `config/openclaw.json` (id: `webex-meeting-join`).
3. Add `"plugins/webex-meeting-join"` to the root `package.json` workspaces
   array (it has its own npm dependencies — `@webex/plugin-meetings` and its
   direct dependencies, `playwright`, `esbuild`, and `@deepgram/sdk` — so it
   must be a workspace member; a dependency-free plugin wouldn't need this). No
   `ffmpeg` is required: unlike the Deepgram streaming example, audio is decoded
   to PCM in-browser via WebAudio, not by shelling out to ffmpeg.
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
`media:ready` event (`type: 'remoteAudio'`). `audio-monitor.js` verifies audio
two independent ways, both logged through the `__openclawMeetingAudioLog`
binding exposed in `browser-runtime.js`:

- **Decoded level (RMS).** The stream runs through a WebAudio `AnalyserNode`
  (routed to a muted gain node so samples flow in headless Chromium without
  emitting sound). Logs on the rising edge when audio becomes audible, a
  throttled heartbeat while it stays audible, and when it goes quiet. This
  proves audio is *decoding* — but a silent room legitimately reads zero.
- **RTP flow (`getStats`).** Every 5s it reads the `inbound-rtp` audio stats
  (`packetsReceived`/`bytesReceived`/`audioLevel`) off the negotiated
  `RTCPeerConnection`, logs a one-shot `receiving audio RTP from Webex` the
  first time packets climb, and warns `audio RTP stalled` if flow stops. This
  is the speech-independent proof that audio is actually reaching us, even when
  nobody is talking. Reaching the peer connection walks an SDK-internal path
  (`mediaProperties.webrtcMediaConnection.mediaConnection.pc`); every hop is
  optional and best-effort, so if the SDK shape changes the RTP check simply
  goes quiet and the subscription is unaffected.

`addMedia()` is fire-and-forget from within `join()`: ICE/TURN negotiation can
take several seconds and would otherwise count against the join timeout, so a
media hiccup can never evict an otherwise-successful join. The monitor is torn
down on leave and on `dispose()`.

The same remote-audio `MediaStream` also feeds the transcription capture when
that's enabled (below).

## Real-time transcription & proactive interventions

Enabled only when `DEEPGRAM_API_KEY` is set. End to end:

1. **Capture (browser, `audio-capture.js`).** The remote-audio `MediaStream`
   lives only inside the headless page, so we tap it there: WebAudio resamples
   it to 16 kHz mono and a `ScriptProcessorNode` converts each ~256 ms frame to
   linear16 PCM, base64-encodes it, and hands it to Node through the
   `__openclawMeetingAudioPcm` page binding. The binding is exposed **only** when
   transcription is configured, so with no key nothing is captured and no audio
   crosses the boundary.
2. **Transcribe (Node, `transcription.js`).** One Deepgram Flux
   (`listen.v2`, turn-based) WebSocket per meeting. PCM frames are streamed with
   `sendMedia`; PCM arriving during the connection handshake is buffered and
   flushed on open. We act on `EndOfTurn` messages only — the final transcript
   for a completed speaker turn.
3. **Gate + intervene (Node, `meeting-agent.js`).** Each turn is recorded as
   rolling context; trivially short turns (`< WEBEX_MEETING_MIN_TURN_WORDS`) are
   dropped before any LLM call — unless the turn names the assistant
   (`../webex/address.js#mentionsName`: "bot", "agent", "openclaw", …), which
   always reaches the gate. Turns go through `../webex/gate.js#scoreMessage` —
   the **same** proactivity gate the chat plugin uses — with a `botNamed` hint
   when an assistant name was heard, so the gate can classify the turn as
   `ADDRESSED` (spoken *to* the assistant, not *about* AI). `ADDRESSED` turns
   clear the lower `WEBEX_MEETING_ADDRESSED_GATE_THRESHOLD`; everything else
   must clear `WEBEX_MEETING_GATE_THRESHOLD` (and the type must not be `NONE`).
   Accepted turns are dispatched to the main agent pipeline
   (`runtime.channel.reply…`, the same seam source-observer uses) and the reply
   is posted into the meeting's Webex space. One intervention at a time per room.

The audio is a single mixed transcoded stream, so turns aren't attributed to
individual speakers — interventions treat the meeting as one "participant."

Sessions start on join and are torn down on leave / meeting-ended /
`dispose()`. Everything new lives in this plugin; the only cross-plugin reach is
*calling* the existing gate, as intended.

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

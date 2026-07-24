// Bundled (via esbuild, see browser-runtime.js) and injected into a headless
// Chromium page. This is the only place the actual Webex SDK is used — it's
// a WebRTC/browser SDK and cannot run under plain Node.js.
//
// Deliberately does NOT `require('webex')` (the full aggregator package).
// webex's own dist/webex.js side-effect-requires ~20 plugins, including
// @webex/plugin-encryption and @webex/contact-center — neither needed for
// meeting join/leave. @webex/plugin-encryption transitively pulls in
// node-jose, which calls `helpers.nodeCrypto.getHashes()` (a Node-only
// crypto API with no browser equivalent) at module-load time and crashes
// the whole bundle before any of our own code runs — found by loading the
// full-aggregator bundle in headless Chromium, not from the docs. Requiring
// only @webex/plugin-meetings and its own actual dependencies (per its
// package.json, verified by grep) avoids that plugin entirely and produces
// a smaller, browser-safer bundle.
'use strict';

require('@webex/internal-plugin-device');
require('@webex/internal-plugin-conversation');
require('@webex/internal-plugin-llm');
require('@webex/internal-plugin-mercury');
require('@webex/internal-plugin-metrics');
require('@webex/internal-plugin-support');
require('@webex/internal-plugin-user');
require('@webex/internal-plugin-voicea');
require('@webex/plugin-people');
require('@webex/plugin-rooms');
require('@webex/plugin-meetings');
const WebexCore = require('@webex/webex-core').default;
const {
  activeOnThisDevice,
  findMeeting: findSdkMeeting,
  meetingReferences,
} = require('./sdk-meeting-state');
const { createAudioMonitor } = require('./audio-monitor');
const { createPcmCapture } = require('./audio-capture');

const Webex = WebexCore.extend({ webex: true });

let webex = null;
let lifecycleStage = 'not-initialized';
let lastError = null;

// Live audio monitors keyed by SDK meeting id. Kept module-level so leave()/
// dispose() can tear them down even though join() (where they're created) has
// long since returned.
const audioMonitors = new Map();
// Live PCM captures keyed by SDK meeting id, torn down alongside their monitor.
// Only created when Node exposed the transcription binding (see subscribeAudio).
const audioCaptures = new Map();
// Hidden <audio> elements keyed by SDK meeting id. Chromium does not decode a
// remote WebRTC audio track until a media element consumes it — a
// MediaStreamAudioSourceNode alone is not such a sink (crbug.com/121673) — so
// without this the monitor and the Deepgram PCM capture tap an undecoded track
// and only ever see zeros (RTP packets flow, audioLevel stays 0.0000, no
// transcript). Muted playback forces the decode without emitting sound.
const audioSinks = new Map();

// Public Webex SDK media events. In transcoded (non-multistream) mode — the
// mode our signalling-only join negotiates — the remote audio of every
// participant arrives as one mixed MediaStream on this event.
const MEDIA_READY_EVENT = 'media:ready';
const REMOTE_AUDIO_TYPE = 'remoteAudio';

// Forward a log line from the page to the Node host via the binding
// browser-runtime exposes (`__openclawMeetingAudioLog`). Falls back to console
// so a bundle loaded without that binding (or a future test) still surfaces
// something. Never throws into the caller.
function reportAudio(level, message) {
  try {
    if (typeof window.__openclawMeetingAudioLog === 'function') {
      window.__openclawMeetingAudioLog(level, message);
      return;
    }
  } catch {
    // fall through to console
  }
  try {
    // eslint-disable-next-line no-console
    console.log(`[webex-meeting-join][audio][${level}] ${message}`);
  } catch {
    // nothing else we can do
  }
}

function stopAudioMonitor(meetingId) {
  const monitor = meetingId && audioMonitors.get(meetingId);
  if (monitor) {
    audioMonitors.delete(meetingId);
    try { monitor.stop(); } catch { /* best effort */ }
  }
  const capture = meetingId && audioCaptures.get(meetingId);
  if (capture) {
    audioCaptures.delete(meetingId);
    try { capture.stop(); } catch { /* best effort */ }
  }
  const sink = meetingId && audioSinks.get(meetingId);
  if (sink) {
    audioSinks.delete(meetingId);
    try {
      sink.pause();
      sink.srcObject = null;
    } catch { /* best effort */ }
  }
}

// Keep the remote track decoding (see audioSinks above). Reused across
// media:ready re-fires so a renegotiated stream replaces the old one.
function attachAudioSink(meetingId, stream) {
  try {
    let sink = audioSinks.get(meetingId);
    if (!sink) {
      sink = new Audio();
      sink.muted = true;
      sink.autoplay = true;
      audioSinks.set(meetingId, sink);
    }
    if (sink.srcObject !== stream) sink.srcObject = stream;
    // Autoplay is permitted in this launch (muted + no-user-gesture policy);
    // play() is belt-and-braces in case autoplay didn't kick in.
    sink.play?.().catch?.(() => {});
  } catch (err) {
    reportAudio('warn', `failed to attach audio sink element: ${err?.message ?? err}`);
  }
}

// Start streaming this meeting's remote audio as PCM to Node for transcription,
// but only when Node opted in by exposing the binding (i.e. a Deepgram key is
// configured). Idempotent per meeting. See audio-capture.js.
function startAudioCapture(meetingId, stream) {
  if (typeof window.__openclawMeetingAudioPcm !== 'function') return;
  if (audioCaptures.has(meetingId)) return;
  const capture = createPcmCapture({
    stream,
    sendPcm: (base64) => window.__openclawMeetingAudioPcm(meetingId, base64),
    report: reportAudio,
  });
  audioCaptures.set(meetingId, capture);
}

// Receive-only audio subscription: attach a media connection that receives the
// meeting audio (no microphone, camera, or screen share published — a listening
// bot, never a speaker) and hand the resulting MediaStream to a level meter.
// Best-effort by contract: any failure here logs and returns without disturbing
// the join it was fired from. This is the seam where a future Deepgram
// real-time transcription pipeline will consume `payload.stream`.
// Reaches the RTCPeerConnection the SDK negotiated so we can read inbound-rtp
// stats. The SDK itself walks this same path (mediaProperties.webrtcMedia
// connection.mediaConnection.pc for transcoded, .multistreamConnection.pc.pc
// for multistream). It's an internal shape, so every hop is optional and the
// whole thing is best-effort — a null just disables the RTP-flow check, never
// the audio subscription.
function resolvePeerConnection(meeting) {
  const wmc = meeting?.mediaProperties?.webrtcMediaConnection;
  const pc = wmc?.mediaConnection?.pc ?? wmc?.multistreamConnection?.pc?.pc;
  return typeof pc?.getStats === 'function' ? pc : null;
}

async function inboundAudioStats(meeting) {
  const pc = resolvePeerConnection(meeting);
  if (!pc) return null;
  const report = await pc.getStats();
  let result = null;
  report.forEach((entry) => {
    if (result || entry.type !== 'inbound-rtp' || entry.kind !== 'audio') return;
    result = {
      packetsReceived: entry.packetsReceived,
      bytesReceived: entry.bytesReceived,
      audioLevel: entry.audioLevel,
    };
  });
  return result;
}

async function subscribeAudio(meeting) {
  if (!meeting || audioMonitors.has(meeting.id)) return;
  const monitor = createAudioMonitor({
    meetingId: meeting.id,
    report: reportAudio,
    getInboundAudioStats: () => inboundAudioStats(meeting),
  });
  audioMonitors.set(meeting.id, monitor);

  meeting.on(MEDIA_READY_EVENT, (payload) => {
    if (payload?.type !== REMOTE_AUDIO_TYPE || !payload.stream) return;
    // Order matters: the sink element must consume the stream before (well,
    // as soon as) the WebAudio taps read it, or they read undecoded silence.
    attachAudioSink(meeting.id, payload.stream);
    monitor.attachStream(payload.stream);
    startAudioCapture(meeting.id, payload.stream);
  });

  try {
    await meeting.addMedia({
      audioEnabled: true,
      videoEnabled: false,
      shareAudioEnabled: false,
      shareVideoEnabled: false,
      // audioEnabled negotiates a receive direction; sendAudio:false keeps us
      // from publishing any microphone track. receiveVideo:false avoids
      // negotiating video we'd only throw away.
      additionalMediaOptions: { sendAudio: false, sendVideo: false, receiveVideo: false },
    });
    reportAudio('info', `subscribed to meeting audio (meeting ${meeting.id})`);
  } catch (err) {
    stopAudioMonitor(meeting.id);
    reportAudio('warn', `could not subscribe to meeting audio: ${err?.message ?? err}`);
  }
}

function waitForMeetingsReady(instance) {
  // Webex's metrics and device plugins finish constructing from the parent
  // `ready` event. Calling meetings.register() before `meetings:ready` races
  // those handlers and produces misleading errors such as
  // `Metrics.sendBehavioralMetric ... reading 'internal'` and
  // `newMetrics.callDiagnosticMetrics ... reading 'setDeviceInfo'`.
  //
  // The ready event is asynchronous, but keep the state check so this remains
  // safe if Webex changes its initialization timing in a later 3.x release.
  if (instance.ready && instance.internal?.newMetrics?.callDiagnosticMetrics) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    instance.meetings.once('meetings:ready', resolve);
  });
}

function assertMeetingDependencies(instance) {
  const missing = [
    !instance.meetings && 'meetings',
    !instance.people && 'people',
    !instance.internal?.device && 'internal.device',
    !instance.internal?.mercury && 'internal.mercury',
    !instance.internal?.metrics && 'internal.metrics',
    !instance.internal?.newMetrics && 'internal.newMetrics',
  ].filter(Boolean);

  if (missing.length) {
    throw new Error(`Webex SDK bundle is missing required plugins: ${missing.join(', ')}`);
  }
}

async function init(accessToken) {
  lifecycleStage = 'constructing';
  lastError = null;
  try {
    webex = new Webex({
      config: {
        appName: 'openclaw-webex-meeting-join',
        appPlatform: 'openclaw',
        device: { ephemeral: true },
        meetings: {
          reconnection: { enabled: true },
          experimental: {
            enableUnifiedMeetings: true,
            enableAdhocMeetings: true,
          },
        },
      },
      credentials: { access_token: accessToken },
    });

    assertMeetingDependencies(webex);
    lifecycleStage = 'waiting-for-meetings-ready';
    await waitForMeetingsReady(webex);
    lifecycleStage = 'registering';
    await webex.meetings.register();
    lifecycleStage = 'registered';
  } catch (err) {
    lifecycleStage = 'failed';
    lastError = err?.message ?? String(err);
    throw err;
  }
}

function updateAccessToken(accessToken) {
  if (!webex) throw new Error('webex-meeting-join: browser SDK not initialised');
  if (!webex.credentials?.supertoken) {
    throw new Error('webex-meeting-join: Webex SDK has no active credential to update');
  }
  webex.credentials.supertoken.access_token = accessToken;
}

function cleanSdkText(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value)
    .split('\n')
    .filter((line) => !['undefined', 'null'].includes(line.trim().toLowerCase()))
    .join('\n')
    .trim();
  return text || null;
}

// The SDK nests the real HTTP failure several wrappers deep (e.g.
// JoinMeetingError → intermediate SDK error → WebexHttpError carrying
// statusCode/body). A single `err.error ?? err.cause` hop misses it, which
// is how production logs ended up with "code 2" and no HTTP status or Locus
// error body. Walk the whole chain instead.
function collectErrorChain(err) {
  const chain = [];
  let current = err;
  while (current && typeof current === 'object' && chain.length < 8 && !chain.includes(current)) {
    chain.push(current);
    current = current.error ?? current.cause ?? current.originalError ?? null;
  }
  return chain;
}

function pickFromChain(chain, extract) {
  for (const entry of chain) {
    const value = extract(entry);
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return null;
}

function safeBodySnippet(body) {
  try {
    const text = JSON.stringify(body, (key, value) => (
      /token|authorization|password|secret/i.test(key) ? '[redacted]' : value
    ));
    if (!text || text === '{}') return null;
    return text.length > 600 ? `${text.slice(0, 600)}…` : text;
  } catch {
    return null;
  }
}

function formatSdkError(err) {
  const chain = collectErrorChain(err);
  const status = pickFromChain(
    chain,
    (e) => e?.statusCode ?? e?.status ?? e?.response?.statusCode ?? e?.response?.status
  );
  const rawBody = pickFromChain(chain, (e) => e?.body ?? null);
  const body = rawBody && typeof rawBody === 'object' ? rawBody : null;
  // Prefer the Locus/Webex service errorCode (e.g. 2423xxx) over the SDK's
  // generic wrapper code (JoinMeetingError is always 2).
  const code = body?.errorCode ?? pickFromChain(chain, (e) => e?.body?.errorCode ?? e?.code);
  const detail = cleanSdkText(body?.message)
    ?? cleanSdkText(body?.errors?.map((item) => item?.description).filter(Boolean).join('; '))
    ?? pickFromChain(chain.slice(1), (e) => cleanSdkText(e?.message))
    ?? pickFromChain(chain, (e) => cleanSdkText(e?.reason));
  const bodySnippet = body ? safeBodySnippet(body) : cleanSdkText(rawBody);
  return [
    err?.name && err.name !== 'Error' ? err.name : null,
    cleanSdkText(err?.message) ?? 'Webex SDK operation failed',
    status ? `HTTP ${status}` : null,
    code ? `code ${code}` : null,
    detail && detail !== err?.message ? detail : null,
    bodySnippet && bodySnippet !== detail ? `body ${bodySnippet}` : null,
  ].filter(Boolean).join(' — ');
}

async function confirmJoinedAfterError(meeting) {
  // A Locus join can be committed server-side while the HTTP response path
  // rejects. Let Mercury settle and repeatedly sync because sync may rebuild
  // the Meeting instance under a different SDK id. Return that actual active
  // instance so leave() later targets the right object.
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const meetings = [meeting, ...Object.values(webex.meetings.getAllMeetings?.() ?? {})];
    const active = findSdkMeeting(meeting, meetings, { activeOnly: true });
    if (active) return active;
    if (attempt === 5) break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
    try {
      await webex.meetings.syncMeetings({ keepOnlyLocusMeetings: false });
    } catch {
      // Preserve the original join error if confirmation itself is unavailable.
    }
  }
  return null;
}

// destination/type: see meetings.js#resolveDestination — preferably the same
// HTTPS webLink a human uses, never a roomId/spaceId.
async function join(destination, type) {
  if (!webex) throw new Error('webex-meeting-join: browser SDK not initialised');
  let meeting;
  try {
    meeting = await webex.meetings.create(destination, type);
    // Join is signalling-only; audio is attached afterwards with addMedia().
    await meeting.join({ moderator: false });
    // Fire-and-forget: ICE/TURN media negotiation can take several seconds, and
    // this call runs inside browser-runtime's join timeout. Awaiting it here
    // could time out (and evict) an otherwise-successful join, so let the audio
    // subscription settle in the background — it's a best-effort add-on.
    void subscribeAudio(meeting);
    return meeting.id;
  } catch (err) {
    const diagnostic = formatSdkError(err);
    const recovered = meeting && await confirmJoinedAfterError(meeting);
    if (recovered) {
      void subscribeAudio(recovered);
      return { meetingId: recovered.id ?? meeting.id, recovered: true, diagnostic };
    }
    // Playwright normally serializes only Error.message/stack and hides the
    // HTTP response nested inside JoinMeetingError.error. Re-throw a concise,
    // token-free description so production logs show the actual Webex reason.
    throw new Error(diagnostic);
  }
}

function findMeeting(reference, { activeOnly = false } = {}) {
  return findSdkMeeting(
    reference,
    Object.values(webex.meetings.getAllMeetings?.() ?? {}),
    { activeOnly }
  );
}

async function leave(reference) {
  if (!webex) throw new Error('webex-meeting-join: browser SDK not initialised');
  // Always refresh first. The join response can reject after Locus accepts
  // the call, and a page restart also loses the original Meeting object.
  try {
    await webex.meetings.syncMeetings({ keepOnlyLocusMeetings: false });
  } catch {
    // The existing local object can still be sufficient to leave.
  }
  const meeting = findMeeting(reference, { activeOnly: true }) ?? findMeeting(reference);
  if (!meeting) {
    const id = typeof reference === 'string' ? reference : reference?.meetingId ?? reference?.sdkMeetingId;
    throw new Error(`no local or active Webex meeting object matched ${id ?? 'the requested meeting'}`);
  }
  // We're leaving on request — stop metering its audio now, whatever the leave
  // fetch itself does afterwards.
  stopAudioMonitor(meeting.id);

  // meeting.leave() sends this exact Locus request from the browser. Unlike
  // the join endpoints, some Locus clusters do not return CORS headers for
  // this PUT when the runtime uses its synthetic openclaw.local origin. The
  // SDK then hides the response behind NetworkOrCORSError even though the
  // request itself is valid. Webex exposes this public helper for callers
  // that need to dispatch the leave fetch themselves (normally pagehide).
  // Keep construction and authentication in the SDK, but let the Node host
  // perform the returned request outside browser CORS.
  const options = await meeting.buildLeaveFetchRequestOptions();
  const headers = options.headers instanceof Headers
    ? Object.fromEntries(options.headers.entries())
    : { ...(options.headers ?? {}) };
  return {
    url: options.uri ?? options.url,
    method: options.method,
    headers,
    body: options.body,
  };
}

async function confirmLeft(reference) {
  if (!webex) throw new Error('webex-meeting-join: browser SDK not initialised');
  // Mercury usually updates the object immediately. A sync also ensures a
  // long-lived headless page does not retain an active object after the raw
  // fetch path above. Confirmation is best-effort: a successful Locus HTTP
  // response is authoritative even if this follow-up sync is unavailable.
  await webex.meetings.syncMeetings({ keepOnlyLocusMeetings: false });
  return !findMeeting(reference, { activeOnly: true });
}

// Rebuilds the SDK's local meeting-object cache from Webex's own state.
// Used after a browser/page restart so any meetings that were joined before
// the crash are rediscovered (the SDK, not just our own state.js, needs to
// know about them again before leave() can find them).
async function syncActive() {
  if (!webex) throw new Error('webex-meeting-join: browser SDK not initialised');
  await webex.meetings.syncMeetings({ keepOnlyLocusMeetings: false });
  return Object.values(webex.meetings.getAllMeetings())
    .filter(activeOnThisDevice)
    .map((meeting) => ({
      sdkMeetingId: meeting.id,
      references: Array.from(meetingReferences(meeting)),
    }));
}

async function dispose() {
  const trackedMeetingIds = new Set([...audioMonitors.keys(), ...audioCaptures.keys(), ...audioSinks.keys()]);
  for (const meetingId of trackedMeetingIds) stopAudioMonitor(meetingId);
  if (!webex) return;
  if (webex.meetings?.registered) await webex.meetings.unregister();
  webex = null;
  lifecycleStage = 'disposed';
}

function status() {
  return {
    stage: lifecycleStage,
    lastError,
    sdkReady: Boolean(webex?.ready),
    meetingsReady: Boolean(webex?.meetings?.meetingInfo),
    meetingsRegistered: Boolean(webex?.meetings?.registered),
    deviceRegistered: Boolean(webex?.internal?.device?.registered),
    mercuryConnected: Boolean(webex?.internal?.mercury?.connected),
  };
}

window.__webexMeetingJoin = { init, updateAccessToken, join, leave, confirmLeft, syncActive, dispose, status };

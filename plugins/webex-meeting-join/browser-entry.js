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

const Webex = WebexCore.extend({ webex: true });

let webex = null;
let lifecycleStage = 'not-initialized';
let lastError = null;

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

function formatSdkError(err) {
  const cause = err?.error ?? err?.cause;
  const status = cause?.statusCode
    ?? cause?.status
    ?? cause?.response?.statusCode
    ?? cause?.response?.status
    ?? err?.statusCode
    ?? err?.status;
  const code = cause?.body?.errorCode ?? cause?.code ?? err?.code;
  const detail = cleanSdkText(cause?.body?.message)
    ?? cleanSdkText(cause?.body?.errors?.map((item) => item?.description).filter(Boolean).join('; '))
    ?? cleanSdkText(cause?.message)
    ?? cleanSdkText(cause?.reason);
  return [
    err?.name && err.name !== 'Error' ? err.name : null,
    cleanSdkText(err?.message) ?? 'Webex SDK operation failed',
    status ? `HTTP ${status}` : null,
    code ? `code ${code}` : null,
    detail && detail !== err?.message ? detail : null,
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
    // Webex explicitly supports a signaling-only join. Media can be attached
    // later with addMedia(); phase 1 deliberately joins without microphone,
    // camera, or remote media.
    await meeting.join({ moderator: false });
    return meeting.id;
  } catch (err) {
    const diagnostic = formatSdkError(err);
    const recovered = meeting && await confirmJoinedAfterError(meeting);
    if (recovered) {
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

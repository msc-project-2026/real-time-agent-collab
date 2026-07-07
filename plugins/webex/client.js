// Runs inside the headless page loaded by meetingRuntime.js — this file
// itself gets bundled by esbuild (see package.json's build:meeting-client),
// but it does NOT import the `webex` package directly. The Webex SDK is
// loaded separately in meeting-client.html via a plain <script> tag pointing
// at the prebuilt UMD bundle (webex-sdk.min.js, copied from node_modules by
// copy-webex-sdk.js), which sets window.Webex.
//
// Why: esbuild trying to bundle the raw `webex` package pulls in the SDK's
// internal dependencies, several of which require Node built-ins (url,
// util, querystring) that esbuild doesn't polyfill by default. The prebuilt
// UMD bundle already handles all of that internally — it's the same
// artifact Cisco's own browser-usage docs recommend loading via <script>.
// Bundling only this thin glue file avoids the problem entirely.

/* global Webex */

let webex = null;
let currentMeeting = null;

window.__startMeetingClient = async function (accessToken, refreshToken, destination) {
  webex = Webex.init({
    // credentials must be top-level — every official SDK example
    // (Node.js docs, Browser SDK quickstart) uses Webex.init({ credentials: {...} }),
    // NOT Webex.init({ config: { credentials: {...} } }). Nesting it under
    // config was silently causing the SDK to never receive a real
    // access_token at all, which is what "SDK cannot authorize" traced
    // back to — a local, synchronous check, not a network/auth failure.
    credentials: {
      access_token: accessToken,
      refresh_token: refreshToken,
    },
    // Plugin-config overrides (like logger) DO belong under config.
    config: {
      logger: {
        level: 'debug',
      },
    },
  });

  await webex.meetings.register();
  await webex.meetings.syncMeetings();

  currentMeeting = await webex.meetings.create(destination);

  currentMeeting.on('meeting:receiveTranscription:started', (payload) => {
    // payload shape per Webex JS SDK docs:
    // { personId, transcription: { text }, timestamp, type: 'interim' | 'final' }
    window.__onTranscriptSegment({
      personId: payload.personId,
      text: payload.transcription?.text ?? '',
      isFinal: payload.type === 'final',
      timestamp: payload.timestamp ?? Date.now(),
    });
  });

  currentMeeting.on('meeting:left', () => window.__onMeetingLeft?.());

  await currentMeeting.join({ receiveTranscription: true });
};

window.__leaveMeetingClient = async function () {
  await currentMeeting?.leave();
};
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
    config: {
      credentials: {
        access_token: accessToken,
        // Passed through in case the SDK's internal canAuthorize check
        // needs a refresh_token present even when the access_token is
        // still valid — added to diagnose a "SDK cannot authorize" error
        // that occurred with access_token alone.
        refresh_token: refreshToken,
      },
      // Verbose SDK logging — surfaces the SDK's own internal reason for
      // any auth/registration failure, rather than the generic top-level
      // error message alone. Forwarded to Node logs via the page 'console'
      // listener in meetingRuntime.js — set back to 'error' once the
      // current auth issue is resolved, since debug level is noisy.
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
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

const Webex = WebexCore.extend({ webex: true });

let webex = null;

async function init(accessToken) {
  webex = new Webex({
    config: {
      sdkType: 'webex',
      hydra: 'https://api.ciscospark.com/v1',
      hydraServiceUrl: 'https://api.ciscospark.com/v1',
      credentials: { clientType: 'confidential' },
      device: { validateDomains: true, ephemeral: true },
      appName: 'openclaw-webex-meeting-join',
      appPlatform: 'openclaw',
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
  await webex.meetings.register();
}

// destination/type: see meetings.js#resolveDestination — meetingId or
// sipUrl, never a roomId/spaceId (Webex rejects that with error 30105).
async function join(destination, type) {
  if (!webex) throw new Error('webex-meeting-join: browser SDK not initialised');
  const meeting = await webex.meetings.create(destination, type);
  await meeting.join({ moderator: false, receiveTranscription: false });
  return meeting.id;
}

async function leave(meetingId) {
  if (!webex) throw new Error('webex-meeting-join: browser SDK not initialised');
  const meeting = webex.meetings.getAllMeetings()[meetingId];
  if (!meeting) throw new Error(`no local meeting object for ${meetingId} (already left, or never joined in this browser session)`);
  await meeting.leave();
}

// Rebuilds the SDK's local meeting-object cache from Webex's own state.
// Used after a browser/page restart so any meetings that were joined before
// the crash are rediscovered (the SDK, not just our own state.js, needs to
// know about them again before leave() can find them).
async function syncActive() {
  if (!webex) throw new Error('webex-meeting-join: browser SDK not initialised');
  await webex.meetings.syncMeetings();
  return Object.keys(webex.meetings.getAllMeetings());
}

window.__webexMeetingJoin = { init, join, leave, syncActive };

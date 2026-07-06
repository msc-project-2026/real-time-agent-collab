'use strict';

// Joins a Webex meeting headlessly and forwards final transcription segments
// into meeting-bridge.js's ingestTranscript().
//
//
// Also required before this works at all:
//   - Webex Assistant must be enabled on the meeting (host/account setting,
//     not settable via this code — see Webex's meetingsPreferences API for
//     the enabledWebexAssistantByDefault flag, or turn it on manually).
//   - accessToken needs meeting-join scopes. If your existing OAuth
//     integration (see token.js) already carries those scopes, you can reuse
//     the same access token here rather than a separate guest-issuer identity.
//   - PUPPETEER_EXECUTABLE_PATH must point at a real Chromium binary
//     (see openclaw.Dockerfile — puppeteer's own bundled-Chromium download
//     is skipped by --ignore-scripts, so a system Chromium is installed via
//     apt and referenced here instead).

const puppeteer = require('puppeteer');
const path = require('node:path');
const { ingestTranscript } = require('./bridge');

// One browser/page per active meeting join.
const activeSessions = new Map(); // Map<meetingId, { browser, page }>

async function joinMeeting({ meetingId, destination, accessToken, cfg, account, log }) {
  if (activeSessions.has(meetingId)) {
    log?.warn?.(`[webex:meeting] already joined meetingId=${meetingId}`);
    return;
  }

  const browser = await puppeteer.launch({
    headless: 'new',
    // Falls back to puppeteer's own bundled Chromium (undefined) if the env
    // var isn't set — e.g. when running locally outside the container.
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: [
      '--use-fake-ui-for-media-stream', // auto-grant mic/cam permission prompts
      '--use-fake-device-for-media-stream', // no real mic/camera needed for join
      '--autoplay-policy=no-user-gesture-required',
      '--no-sandbox', // needed in most container runtimes; drop if your VPS setup allows otherwise
    ],
  });

  const page = await browser.newPage();

  // Bridge: browser-context transcription events → Node → ingestTranscript()
  await page.exposeFunction('__onTranscriptSegment', async (segment) => {
    try {
      await ingestTranscript({ ...segment, meetingId }, { cfg, account, log });
    } catch (err) {
      log?.error?.(`[webex:meeting] ingest error: ${err?.message ?? err}`);
    }
  });

  await page.exposeFunction('__onMeetingLeft', () => {
    log?.info?.(`[webex:meeting] left meetingId=${meetingId}`);
    activeSessions.delete(meetingId);
  });

  // meeting-client.html bundles client.js + the `webex` npm package for the
  // browser (webpack/esbuild — it needs real browser WebRTC APIs, won't run
  // under plain Node).
  await page.goto(`file://${path.join(__dirname, 'meeting-client.html')}`);

  await page.evaluate(
    (token, dest) => window.__startMeetingClient(token, dest),
    accessToken,
    destination
  );

  activeSessions.set(meetingId, { browser, page });
  log?.info?.(`[webex:meeting] joined meetingId=${meetingId}`);
}

async function leaveMeeting(meetingId) {
  const session = activeSessions.get(meetingId);
  if (!session) return;
  await session.page.evaluate(() => window.__leaveMeetingClient?.());
  await session.browser.close();
  activeSessions.delete(meetingId);
}

module.exports = { joinMeeting, leaveMeeting };
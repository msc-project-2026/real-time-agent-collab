'use strict';

// Joins a Webex meeting headlessly and forwards final transcription segments
// into bridge.js's ingestTranscript().
//
// Uses Playwright's Chromium rather than Puppeteer's Chrome for Testing.
// Chrome for Testing (what Puppeteer bundles) has no official Linux ARM64
// build at all — see https://pptr.dev/guides/system-requirements. Playwright
// maintains its own separately-built Chromium and explicitly documents
// Debian 12 Bookworm arm64 support, which is what actually let this run on
// an Ampere ARM VPS. See openclaw.Dockerfile for the `playwright install
// --with-deps chromium` build step that downloads this browser.
//
// Also required before this works at all:
//   - Webex Assistant must be enabled on the meeting (host/account setting,
//     not settable via this code — see Webex's meetingsPreferences API for
//     the enabledWebexAssistantByDefault flag, or turn it on manually).
//   - accessToken needs meeting-join scopes (see channel.js/token.js
//     comments) and the account needs a Webex Meetings license.

const { chromium } = require('playwright');
const path = require('node:path');
const { ingestTranscript } = require('./bridge');

// One browser/page per active meeting join.
const activeSessions = new Map(); // Map<meetingId, { browser, page }>

async function joinMeeting({ meetingId, destination, accessToken, refreshToken, cfg, account, log }) {
  if (activeSessions.has(meetingId)) {
    log?.warn?.(`[webex:meeting] already joined meetingId=${meetingId}`);
    return;
  }

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--use-fake-ui-for-media-stream', // auto-grant mic/cam permission prompts
      '--use-fake-device-for-media-stream', // no real mic/camera needed for join
      '--autoplay-policy=no-user-gesture-required',
      '--no-sandbox', // needed in most container runtimes; drop if your VPS setup allows otherwise
      '--disable-dev-shm-usage', // Docker's default 64MB /dev/shm is too small for Chromium; this makes it use /tmp instead
    ],
  });

  const page = await browser.newPage();

  // Forward the page's own console output to our logs — without this,
  // client.js's SDK debug logging (see its logger.level: 'debug' config)
  // would only print inside the headless browser, invisible to us.
  page.on('console', (msg) => {
    log?.info?.(`[webex:meeting:console] ${msg.text()}`);
  });
  page.on('pageerror', (err) => {
    log?.error?.(`[webex:meeting:pageerror] ${err?.message ?? err}`);
  });

  // Bridge: browser-context transcription events → Node → ingestTranscript()
  // Playwright's exposeFunction has the same signature/behavior as Puppeteer's.
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

  // meeting-client.html loads webex-sdk.min.js (prebuilt UMD SDK) then
  // meeting-client.bundle.js (esbuild output of client.js) — see
  // package.json's build:meeting-client script and copy-webex-sdk.js.
  await page.goto(`file://${path.join(__dirname, 'meeting-client.html')}`);

  await page.evaluate(
    ([token, refresh, dest]) => window.__startMeetingClient(token, refresh, dest),
    [accessToken, refreshToken, destination]
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
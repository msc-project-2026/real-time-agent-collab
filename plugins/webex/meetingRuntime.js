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
// IMPORTANT: meeting-client.html is served over a local HTTP server, NOT
// loaded via file://. Browsers assign the literal origin `null` to file://
// pages, and Webex's API rejects cross-origin requests from a null origin
// (CORS preflight failure) — every SDK network call was silently failing
// at the browser layer, which is what the misleading "SDK cannot authorize"
// error actually traced back to. Cisco's own Browser SDK quickstart serves
// its sample from http://localhost for the same reason.
//
// Also required before this works at all:
//   - Webex Assistant must be enabled on the meeting (host/account setting,
//     not settable via this code — see Webex's meetingsPreferences API for
//     the enabledWebexAssistantByDefault flag, or turn it on manually).
//   - accessToken needs meeting-join scopes (see channel.js/token.js
//     comments) and the account needs a Webex Meetings license.

const { chromium } = require('playwright');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const { ingestTranscript } = require('./bridge');

// Bound to localhost only — this server has no reason to be reachable from
// outside the container, it exists purely to give the headless page a real
// HTTP origin instead of file://.
const LOCAL_SERVER_PORT = 34567;
const LOCAL_SERVER_HOST = '127.0.0.1';

const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'application/javascript',
};

let serverStarted = false;

function ensureLocalServer(log) {
  if (serverStarted) return;

  const server = http.createServer((req, res) => {
    // Only ever serves files from this plugin's own directory — no path
    // traversal handling needed since the only requests that will ever
    // arrive are the ones meeting-client.html itself issues for its two
    // known script tags.
    const reqPath = new URL(req.url, `http://${LOCAL_SERVER_HOST}`).pathname;
    const filePath = path.join(__dirname, reqPath === '/' ? 'meeting-client.html' : reqPath);
    const ext = path.extname(filePath);

    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.statusCode = 404;
        res.end('Not found');
        return;
      }
      res.setHeader('Content-Type', MIME_TYPES[ext] ?? 'application/octet-stream');
      res.end(data);
    });
  });

  server.listen(LOCAL_SERVER_PORT, LOCAL_SERVER_HOST, () => {
    log?.info?.(`[webex:meeting] local static server listening on http://${LOCAL_SERVER_HOST}:${LOCAL_SERVER_PORT}`);
  });

  serverStarted = true;
}

// One browser/page per active meeting join.
const activeSessions = new Map(); // Map<meetingId, { browser, page }>

async function joinMeeting({ meetingId, destination, accessToken, refreshToken, cfg, account, log }) {
  if (activeSessions.has(meetingId)) {
    log?.warn?.(`[webex:meeting] already joined meetingId=${meetingId}`);
    return;
  }

  ensureLocalServer(log);

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

  // Served over http://127.0.0.1 rather than file:// — see the header
  // comment for why file:// (origin `null`) breaks Webex's API calls.
  await page.goto(`http://${LOCAL_SERVER_HOST}:${LOCAL_SERVER_PORT}/meeting-client.html`);

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
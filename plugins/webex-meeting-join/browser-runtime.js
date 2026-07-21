// Hosts the actual Webex Browser SDK inside a headless Chromium page via
// Playwright, and drives it with page.evaluate() calls into the bundle
// produced from browser-entry.js. This is the one piece of the plugin that
// cannot be exercised by this repo's unit tests (no live Webex meeting/token
// available in CI) — orchestrator.js takes this module through a small
// injectable interface specifically so the rest of the plugin's logic can be
// tested without it. See the "still needs live verification" section of the
// implementation notes for exactly what's unverified here.
'use strict';

const path = require('node:path');
const fs = require('node:fs');

const BUNDLE_CACHE_PATH = path.join(__dirname, '.generated', 'browser-entry.bundle.js');

// Bundles browser-entry.js (which requires the Node-oriented `webex` package)
// into a single browser-runnable script. Built once and cached to disk so a
// restart doesn't re-bundle unless the source changed — esbuild itself never
// touches the network at build time (only its own npm install does, via
// per-platform optionalDependencies, which works fine under `npm install
// --ignore-scripts`).
async function ensureBundle(log) {
  const entryPath = path.join(__dirname, 'browser-entry.js');
  const entryMtime = fs.statSync(entryPath).mtimeMs;
  if (fs.existsSync(BUNDLE_CACHE_PATH)) {
    const cached = fs.statSync(BUNDLE_CACHE_PATH);
    if (cached.mtimeMs >= entryMtime) return fs.readFileSync(BUNDLE_CACHE_PATH, 'utf-8');
  }
  const esbuild = require('esbuild');
  const { polyfillNode } = require('esbuild-plugin-polyfill-node');
  // The `webex` package is nominally browser-oriented but several internal
  // modules still `require()` Node built-ins (url, querystring, util, os,
  // stream) directly — discovered by actually running this bundle step, not
  // from the docs. esbuild's browser platform has no built-in polyfills for
  // these (unlike webpack 4, which Webex's own sample app likely relies on),
  // so bundling fails outright without an explicit polyfill plugin. The
  // polyfill plugin requires esbuild's async `build()` API — its sync
  // `buildSync()` rejects any `plugins` option outright.
  const result = await esbuild.build({
    entryPoints: [entryPath],
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'iife',
    target: 'chrome120',
    // `define: { global: 'globalThis' }` is needed on top of the polyfill
    // plugin: some of webex's dependencies reference the bare Node `global`
    // identifier (not just `require()` a builtin module), which throws
    // "global is not defined" in a real browser page — found by actually
    // loading the bundle in headless Chromium, not from the docs.
    define: { global: 'globalThis' },
    // jsonwebtoken (pulled in only by @webex/webex-core's credentials.js and
    // the unused authorization plugins) transitively breaks under the
    // `stream` polyfill — see browser-stubs/jsonwebtoken.js for why the stub
    // is behaviorally safe for our access_token-only (non-JWT) auth flow.
    //
    // node-jose (pulled in transitively by internal-plugin-conversation ->
    // internal-plugin-encryption, an undeclared coupling not excludable by
    // simply not requiring the encryption plugin ourselves) calls a
    // Node-only crypto API at module-load time — see
    // browser-stubs/node-jose.js for why this is safe given we never touch
    // message-content (KMS/JOSE) encryption in the meeting join/leave flow.
    alias: {
      jsonwebtoken: path.join(__dirname, 'browser-stubs', 'jsonwebtoken.js'),
      'node-jose': path.join(__dirname, 'browser-stubs', 'node-jose.js'),
    },
    plugins: [polyfillNode()],
  });
  const code = result.outputFiles[0].text;
  fs.mkdirSync(path.dirname(BUNDLE_CACHE_PATH), { recursive: true });
  fs.writeFileSync(BUNDLE_CACHE_PATH, code);
  log?.info?.('[webex-meeting-join] browser bundle built and cached');
  return code;
}

function createBrowserRuntime({ log, joinTimeoutMs }) {
  let browser = null;
  let page = null;
  let initialized = false;
  let bundleCode = null;

  async function ensureBrowserAlive() {
    if (browser?.isConnected?.()) return;
    const { chromium } = require('playwright');
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });
    page = await browser.newPage();
    bundleCode ??= await ensureBundle(log);
    await page.addScriptTag({ content: bundleCode });
    initialized = false; // a fresh browser needs webex.meetings.register() again
    log?.info?.('[webex-meeting-join] headless browser (re)started');
  }

  async function withTimeout(promise, label) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${joinTimeoutMs}ms`)), joinTimeoutMs);
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  async function init(accessToken) {
    await ensureBrowserAlive();
    if (initialized) return;
    await withTimeout(page.evaluate((token) => window.__webexMeetingJoin.init(token), accessToken), 'SDK init');
    initialized = true;
  }

  async function join(destination, type) {
    await ensureBrowserAlive();
    if (!initialized) throw new Error('webex-meeting-join: browser runtime not initialised — call init() first');
    return withTimeout(
      page.evaluate(({ d, t }) => window.__webexMeetingJoin.join(d, t), { d: destination, t: type }),
      'meeting join'
    );
  }

  async function leave(meetingId) {
    await ensureBrowserAlive();
    if (!initialized) throw new Error('webex-meeting-join: browser runtime not initialised — call init() first');
    return withTimeout(page.evaluate((id) => window.__webexMeetingJoin.leave(id), meetingId), 'meeting leave');
  }

  async function syncActive() {
    await ensureBrowserAlive();
    if (!initialized) return [];
    return withTimeout(page.evaluate(() => window.__webexMeetingJoin.syncActive()), 'meeting sync');
  }

  async function dispose() {
    await browser?.close?.().catch(() => {});
    browser = null;
    page = null;
    initialized = false;
  }

  return { init, join, leave, syncActive, dispose };
}

module.exports = { createBrowserRuntime, ensureBundle, BUNDLE_CACHE_PATH };

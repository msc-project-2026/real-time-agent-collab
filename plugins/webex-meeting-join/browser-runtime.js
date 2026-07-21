// Hosts the actual Webex Browser SDK inside a headless Chromium page via
// Playwright, and drives it with page.evaluate() calls into the bundle
// produced from browser-entry.js. Browser lifecycle and retry behavior are
// unit-tested through injected Playwright fakes; real SDK registration still
// needs a live Webex token and is covered by the manual smoke check described
// in the README.
'use strict';

const path = require('node:path');
const fs = require('node:fs');

const BUNDLE_CACHE_PATH = path.join(__dirname, '.generated', 'browser-entry.bundle.js');
const RUNTIME_ORIGIN = 'http://openclaw.local';

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

function createBrowserRuntime({ log, joinTimeoutMs, launchChromium, loadBundle = ensureBundle }) {
  let browser = null;
  let page = null;
  let initialized = false;
  let bundleCode = null;
  let lastAccessToken = null;
  let activeAccessToken = null;
  let initPromise = null;
  let browserPromise = null;
  let pagePromise = null;

  async function createPage() {
    page = await browser.newPage();
    // A new Playwright page starts at about:blank and therefore sends
    // `Origin: null`. Webex's U2C and Hydra preflight responses reject that
    // origin, leaving meetings.register() stuck until its 60-second catalog
    // timeout. Fulfill a tiny in-memory document at a stable HTTP origin so
    // the SDK's CORS requests carry a valid Origin header; no server, DNS, or
    // external page is involved.
    if (page.route && page.goto) {
      await page.route(`${RUNTIME_ORIGIN}/**`, (route) => route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<!doctype html><title>OpenClaw Webex runtime</title>',
      }));
      await page.goto(`${RUNTIME_ORIGIN}/`, { waitUntil: 'domcontentloaded' });
    }
    bundleCode ??= await loadBundle(log);
    await page.addScriptTag({ content: bundleCode });
    initialized = false;
    activeAccessToken = null;
  }

  async function ensureBrowserAlive() {
    if (!browser?.isConnected?.()) {
      const launch = launchChromium ?? ((options) => require('playwright').chromium.launch(options));
      browserPromise ??= launch({
        headless: true,
        args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
      })
        .then((launchedBrowser) => {
          browser = launchedBrowser;
          page = null;
          log?.info?.('[webex-meeting-join] headless browser (re)started');
        })
        .finally(() => {
          browserPromise = null;
        });
      await browserPromise;
    }
    if (!page || page.isClosed?.()) {
      pagePromise ??= createPage().finally(() => {
        pagePromise = null;
      });
      await pagePromise;
    }
  }

  async function resetPage() {
    const stalePage = page;
    page = null;
    initialized = false;
    activeAccessToken = null;
    await stalePage?.close?.().catch(() => {});
  }

  async function withTimeout(promise, label, { resetOnTimeout = false } = {}) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        if (resetOnTimeout) void resetPage();
        reject(new Error(`${label} timed out after ${joinTimeoutMs}ms`));
      }, joinTimeoutMs);
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  async function init(accessToken) {
    if (typeof accessToken !== 'string' || !accessToken.trim()) {
      throw new Error('webex-meeting-join: a non-empty Webex access token is required');
    }
    lastAccessToken = accessToken;
    await ensureBrowserAlive();
    if (initialized) {
      if (activeAccessToken !== accessToken) {
        await withTimeout(
          page.evaluate((token) => window.__webexMeetingJoin.updateAccessToken(token), accessToken),
          'SDK token update',
          { resetOnTimeout: true }
        );
        activeAccessToken = accessToken;
      }
      return;
    }
    if (initPromise) {
      await initPromise;
      // A token refresh may have raced the original initialization. Re-enter
      // the idempotent path so the newly initialized instance receives it.
      if (activeAccessToken !== accessToken) return init(accessToken);
      return;
    }

    const initPage = page;
    initPromise = withTimeout(
      initPage.evaluate((token) => window.__webexMeetingJoin.init(token), accessToken),
      'SDK init',
      { resetOnTimeout: true }
    )
      .then(() => {
        // A timeout may already have invalidated this page.
        if (page !== initPage) throw new Error('SDK init completed on a stale browser page');
        initialized = true;
        activeAccessToken = accessToken;
      })
      .catch(async (err) => {
        // Never retry in the same JS realm after partial SDK registration.
        // Several Webex helpers are module-level singletons and otherwise keep
        // references to the failed instance, causing the next attempt to fail
        // with unrelated metrics/device TypeErrors.
        if (page === initPage) await resetPage();
        throw err;
      })
      .finally(() => {
        initPromise = null;
      });
    return initPromise;
  }

  // ensureBrowserAlive() resets `initialized` to false whenever it has to
  // (re)launch Chromium — e.g. the previous browser crashed or was never
  // started — because a fresh page needs webex.meetings.register() again.
  // Re-run init() with the last known token in that case instead of just
  // throwing, so a browser crash between orchestrator.start() and the next
  // join/leave call self-heals rather than permanently breaking joins.
  async function ensureInitialized() {
    await ensureBrowserAlive();
    if (initialized) return;
    if (!lastAccessToken) throw new Error('webex-meeting-join: browser runtime not initialised — call init() first');
    await init(lastAccessToken);
  }

  async function join(destination, type) {
    await ensureInitialized();
    try {
      const result = await withTimeout(
        page.evaluate(({ d, t }) => window.__webexMeetingJoin.join(d, t), { d: destination, t: type }),
        'meeting join',
        { resetOnTimeout: true }
      );
      if (result?.recovered && result?.meetingId) {
        log?.warn?.(
          '[webex-meeting-join] SDK join response was inconclusive, but Locus confirmed this device joined; continuing as joined'
        );
        return result.meetingId;
      }
      return result;
    } catch (err) {
      if (page?.isClosed?.()) initialized = false;
      throw err;
    }
  }

  async function leave(reference) {
    await ensureInitialized();
    return withTimeout(
      page.evaluate((ref) => window.__webexMeetingJoin.leave(ref), reference),
      'meeting leave',
      { resetOnTimeout: true }
    );
  }

  async function syncActive() {
    await ensureBrowserAlive();
    if (!initialized) return [];
    return withTimeout(page.evaluate(() => window.__webexMeetingJoin.syncActive()), 'meeting sync');
  }

  async function status() {
    await ensureBrowserAlive();
    return page.evaluate(() => window.__webexMeetingJoin.status());
  }

  async function dispose() {
    if (page && !page.isClosed?.() && initialized) {
      await withTimeout(page.evaluate(() => window.__webexMeetingJoin.dispose()), 'SDK dispose').catch((err) => {
        log?.warn?.(`[webex-meeting-join] SDK dispose failed: ${err?.message ?? err}`);
      });
    }
    await browser?.close?.().catch(() => {});
    browser = null;
    page = null;
    initialized = false;
    activeAccessToken = null;
    initPromise = null;
    browserPromise = null;
    pagePromise = null;
  }

  return { init, join, leave, syncActive, status, dispose };
}

module.exports = { createBrowserRuntime, ensureBundle, BUNDLE_CACHE_PATH, RUNTIME_ORIGIN };

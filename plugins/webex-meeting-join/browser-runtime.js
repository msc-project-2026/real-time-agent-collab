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
const LOCUS_LEAVE_PATH = /^\/locus\/api\/v1\/loci\/[^/]+\/participant\/[^/]+\/leave$/;

// The Webex SDK hardcodes `requireH264: true` (with `skipInactiveTransceivers:
// false`) for its transcoded media connection, so addMedia() validates that
// the local SDP's video m-line offers H264 even though we only ever receive
// audio. Playwright's stock Chromium has no proprietary codecs (no arm64
// Chrome build exists to swap in either), so audio subscription fails there
// with "H264 codec is missing for video media description". Brave bundles
// H264 and is already installed in the deployment image, so prefer it when
// present. Order matters: Linux (the deployed container) first, then macOS
// for local development.
const BRAVE_EXECUTABLE_CANDIDATES = [
  '/usr/bin/brave-browser',
  '/usr/bin/brave',
  '/opt/brave.com/brave/brave-browser',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
];

// Resolves which browser binary to launch. An explicitly configured path wins
// and is required to exist (fail loudly over silently degrading to a browser
// that cannot do meeting audio); otherwise probe for Brave and fall back to
// Playwright's bundled Chromium (join/leave still work there — only the audio
// subscription needs H264).
function resolveExecutablePath({ configuredPath, log, fileExists = fs.existsSync }) {
  if (configuredPath) {
    if (!fileExists(configuredPath)) {
      throw new Error(`webex-meeting-join: WEBEX_MEETING_BROWSER_EXECUTABLE not found: ${configuredPath}`);
    }
    return configuredPath;
  }
  const brave = BRAVE_EXECUTABLE_CANDIDATES.find((candidate) => fileExists(candidate));
  if (brave) return brave;
  log?.warn?.(
    '[webex-meeting-join] no H264-capable browser found (set WEBEX_MEETING_BROWSER_EXECUTABLE or install Brave); '
    + "falling back to Playwright's Chromium — joins will work but meeting audio subscription will fail"
  );
  return undefined;
}

function assertLocusLeaveRequest(request) {
  let url;
  try {
    url = new URL(request?.url);
  } catch {
    throw new Error('Webex SDK returned an invalid Locus leave URL');
  }
  const isWebexLocusHost = url.hostname === 'wbx2.com' || url.hostname.endsWith('.wbx2.com');
  if (url.protocol !== 'https:' || !isWebexLocusHost || !LOCUS_LEAVE_PATH.test(url.pathname)) {
    throw new Error(`Webex SDK returned an unexpected Locus leave endpoint: ${url.origin}${url.pathname}`);
  }
  if (String(request?.method ?? '').toUpperCase() !== 'PUT') {
    throw new Error(`Webex SDK returned an unexpected Locus leave method: ${request?.method ?? 'missing'}`);
  }
  return url.href;
}

async function responseErrorDetail(response) {
  const text = await response.text().catch(() => '');
  if (!text) return '';
  try {
    const body = JSON.parse(text);
    return body.message ?? body.error ?? body.errorString ?? text;
  } catch {
    return text;
  }
}

// Bundles browser-entry.js (which requires the Node-oriented `webex` package)
// into a single browser-runnable script. Built once and cached to disk so a
// restart doesn't re-bundle unless the source changed — esbuild itself never
// touches the network at build time (only its own npm install does, via
// per-platform optionalDependencies, which works fine under `npm install
// --ignore-scripts`).
async function ensureBundle(log) {
  const entryPath = path.join(__dirname, 'browser-entry.js');
  const bundledSourcePaths = [
    entryPath,
    path.join(__dirname, 'sdk-meeting-state.js'),
    path.join(__dirname, 'audio-monitor.js'),
  ];
  const sourceMtime = Math.max(...bundledSourcePaths.map((sourcePath) => fs.statSync(sourcePath).mtimeMs));
  if (fs.existsSync(BUNDLE_CACHE_PATH)) {
    const cached = fs.statSync(BUNDLE_CACHE_PATH);
    if (cached.mtimeMs >= sourceMtime) return fs.readFileSync(BUNDLE_CACHE_PATH, 'utf-8');
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

function createBrowserRuntime({
  log,
  joinTimeoutMs,
  executablePath,
  launchChromium,
  loadBundle = ensureBundle,
  fetchImpl = globalThis.fetch,
}) {
  let browser = null;
  let page = null;
  let initialized = false;
  let bundleCode = null;
  let lastAccessToken = null;
  let activeAccessToken = null;
  let initPromise = null;
  let browserPromise = null;
  let pagePromise = null;

  // Network-layer diagnostics, independent of SDK error wrapping: the SDK
  // sometimes buries (or drops) the real Locus/WDM HTTP failure inside nested
  // error objects, so also log every Webex API error response as it happens.
  // Metrics endpoints are excluded — their failures are frequent noise
  // unrelated to join/leave health.
  const WEBEX_API_URL = /https:\/\/[^/]*\.(?:wbx2|webex|webexapis|ciscospark)\.com\//;
  const WEBEX_DIAG_IGNORE = /metrics|pinpoint|amplitude/i;

  function attachNetworkDiagnostics(target) {
    if (typeof target.on !== 'function') return;
    target.on('response', (response) => {
      void (async () => {
        try {
          const status = response.status();
          const url = response.url();
          if (status < 400 || !WEBEX_API_URL.test(url) || WEBEX_DIAG_IGNORE.test(url)) return;
          const body = (await response.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 800);
          log?.warn?.(
            `[webex-meeting-join] Webex API error response: ${response.request().method()} ${url} → HTTP ${status}${body ? ` — ${body}` : ''}`
          );
        } catch {
          // Diagnostics only — never interfere with the join/leave path.
        }
      })();
    });
    target.on('requestfailed', (request) => {
      try {
        const url = request.url();
        if (!WEBEX_API_URL.test(url) || WEBEX_DIAG_IGNORE.test(url)) return;
        log?.warn?.(
          `[webex-meeting-join] Webex request failed without a response (network/CORS): ${request.method()} ${url} — ${request.failure()?.errorText ?? 'unknown'}`
        );
      } catch {
        // Diagnostics only.
      }
    });
  }

  async function createPage() {
    page = await browser.newPage();
    attachNetworkDiagnostics(page);
    // Bridge the audio monitor's page-side logs (see audio-monitor.js /
    // browser-entry.js#reportAudio) to the Node logger. Guarded because the
    // unit-test fake page has no exposeFunction; a fresh page each call means
    // the binding name is never double-registered.
    if (typeof page.exposeFunction === 'function') {
      await page.exposeFunction('__openclawMeetingAudioLog', (level, message) => {
        const emit = log?.[level] ?? log?.info;
        emit?.call(log, `[webex-meeting-join][audio] ${message}`);
      }).catch((err) => {
        log?.warn?.(`[webex-meeting-join] could not expose audio log binding: ${err?.message ?? err}`);
      });
    }
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
      // Resolved lazily (not at createBrowserRuntime time) so a Brave install
      // or config change takes effect on the next relaunch, and so the fake
      // launcher used in unit tests never probes the real filesystem.
      const resolvedExecutablePath = launchChromium
        ? executablePath
        : resolveExecutablePath({ configuredPath: executablePath, log });
      if (resolvedExecutablePath) {
        log?.info?.(`[webex-meeting-join] launching browser: ${resolvedExecutablePath}`);
      }
      browserPromise ??= launch({
        headless: true,
        // Brave (or another Chromium build) via executablePath. Playwright's
        // launch() always creates a fresh ephemeral user-data-dir per launch,
        // so this instance never opens — or contends on the SingletonLock
        // of — the gateway's managed Brave profile, even though both run the
        // same binary in the same container.
        ...(resolvedExecutablePath ? { executablePath: resolvedExecutablePath } : {}),
        // --disable-web-security: several Webex endpoints (the Locus join
        // POST, /people/me, calliope discovery) accept the request server-side
        // but omit CORS headers for our synthetic openclaw.local origin, so
        // Chromium blocks the *response* and the SDK misreports the operation
        // as failed (net::ERR_FAILED, no HTTP status) even though it
        // committed — the same failure class that forced the leave PUT to be
        // dispatched from Node. This page only ever runs our own bundled SDK
        // code via addScriptTag on a route-fulfilled document — no untrusted
        // content — so disabling CORS enforcement here is contained and
        // removes the whole class at once. The openclaw.local origin is still
        // required: Webex rejects requests with no Origin header at all.
        // --autoplay-policy: let the audio monitor's WebAudio graph (see
        // audio-monitor.js) run without a user gesture; otherwise the
        // AudioContext stays suspended in headless Chromium and no samples flow.
        args: [
          '--no-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--disable-web-security',
          '--autoplay-policy=no-user-gesture-required',
        ],
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
    const request = await withTimeout(
      page.evaluate((ref) => window.__webexMeetingJoin.leave(ref), reference),
      'meeting leave preparation',
      { resetOnTimeout: true }
    );
    const url = assertLocusLeaveRequest(request);
    const response = await withTimeout(
      fetchImpl(url, {
        method: 'PUT',
        headers: request.headers,
        body: request.body,
      }),
      'meeting leave',
      { resetOnTimeout: false }
    );
    if (!response.ok) {
      const detail = await responseErrorDetail(response);
      throw new Error(`Webex Locus leave failed with HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
    }
    await withTimeout(
      page.evaluate((ref) => window.__webexMeetingJoin.confirmLeft(ref), reference),
      'meeting leave confirmation'
    ).catch((err) => {
      log?.warn?.(`[webex-meeting-join] leave succeeded but SDK state confirmation failed: ${err?.message ?? err}`);
    });
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

module.exports = {
  createBrowserRuntime,
  ensureBundle,
  assertLocusLeaveRequest,
  resolveExecutablePath,
  BRAVE_EXECUTABLE_CANDIDATES,
  BUNDLE_CACHE_PATH,
  RUNTIME_ORIGIN,
};

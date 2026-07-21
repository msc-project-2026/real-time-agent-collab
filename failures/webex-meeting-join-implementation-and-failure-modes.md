# Webex Meeting Auto-Join — Implementation & Failure Modes Report

Plugin: `plugins/webex-meeting-join/`
Approach implemented: **Approach 2** (webhook-triggered join, decoupled from the SDK's own real-time socket) — selected by the user over the SDK-event-driven alternative during the research phase.
Scope: **join and leave only**. Native/Deepgram transcription is explicitly out of scope (phase 2).

---

## 1. Architecture summary

Webex webhooks (`meetings/started`, `meetings/ended`, `messages/created`) are delivered to this plugin's own HTTP route. On `meetings/started`, the plugin resolves the meeting's `meetingId`/`sipUrl` via REST, confirms the dedicated meeting account is a member of the associated space, and drives a headless Chromium instance (Playwright) that hosts the real `@webex/plugin-meetings` SDK to call `webex.meetings.create()` + `meeting.join()`. A user typing "leave meeting" in the space triggers `meeting.leave()`. A startup reconciliation sweep plus a periodic poll catch any meeting a webhook missed.

The plugin is **self-contained**: it does not `require()` anything from `plugins/webex/*` or `lib/*`. It duplicates the small amount of shared logic it needs (REST fetch helper, HMAC webhook verification, OAuth refresh) rather than importing it, so it can be copied to another OpenClaw instance as a single folder.

---

## 2. File manifest

All paths relative to `plugins/webex-meeting-join/`.

| File | Purpose |
|---|---|
| `openclaw.plugin.json` | Plugin manifest (id `webex-meeting-join`, `activation.onStartup: true`) |
| `package.json` | Own npm dependencies — see §2.1 |
| `.gitignore` | Excludes `node_modules/` and `.generated/` (bundle cache) |
| `README.md` | Setup instructions, env vars, porting steps, known limitations |
| `index.js` | Plugin entry point — `register(api)`: wires `gateway_start`/`gateway_stop`, registers the HTTP webhook route, starts/stops polling |
| `config.js` | Reads all env vars directly (`process.env`), with fallback to the primary webex plugin's shared vars; throws listing every missing required var |
| `api.js` | Own copy of a minimal `webexFetch` REST client (`WebexApiError`, 401 detection) |
| `token.js` | OAuth refresh for the dedicated meeting account; `createTokenStore()` — reactive refresh-and-retry-once on 401, coalesces concurrent refreshes |
| `webhook-subscriptions.js` | Registers/deregisters this plugin's own 3 Webex webhook subscriptions (`ensureWebhooks`, `deregisterWebhooks`) |
| `webhook-router.js` | Own HTTP route handler for inbound Webex webhook POSTs — HMAC-SHA1 verification, fast 200 ACK, path-suffix dispatch (`ROUTE_PREFIX = /webhooks/webex-meeting-join`) |
| `meetings.js` | Meeting-resource helpers: `classifyMeetingKind`, `resolveDestination` (meetingId/sipUrl only, never roomId), `fetchMeetingWithRetry`, `isRoomMember`, `isActiveMeeting`, `listActiveMeetings` |
| `commands.js` | Pure text parsing: `parseCommand` (leave/status), `isAddressedToBot`, `stripMention` |
| `state.js` | `MeetingState` class — in-memory joined/suppressed tracking + `withLock()` per-meetingId concurrency guard |
| `browser-entry.js` | Source bundled into the headless page — the only place the real Webex SDK modules are `require()`d |
| `browser-runtime.js` | Playwright lifecycle, esbuild bundling (`ensureBundle`), browser-alive guard, per-call timeout wrapper |
| `browser-stubs/jsonwebtoken.js` | Browser-bundling stub — see §4.3 |
| `browser-stubs/node-jose.js` | Browser-bundling stub — see §4.4 |
| `orchestrator.js` | Wires webhooks + meeting resolution + state + browser runtime together: `tryJoin`, `tryLeave`, `handleMeetingStarted`, `handleMeetingEnded`, `handleMessageCreated`, `reconcile`, `startPolling` |
| `*.test.cjs` (7 files) | 38 `node:test` unit tests — see §5 |

### 2.1 Dependencies (`package.json`)

```
@webex/webex-core, @webex/plugin-meetings,
@webex/internal-plugin-device, @webex/internal-plugin-conversation,
@webex/internal-plugin-llm, @webex/internal-plugin-mercury,
@webex/internal-plugin-metrics, @webex/internal-plugin-support,
@webex/internal-plugin-user, @webex/internal-plugin-voicea,
@webex/plugin-people, @webex/plugin-rooms   (all pinned 3.12.0)
playwright ^1.52.0
esbuild ^0.28.1
esbuild-plugin-polyfill-node ^0.3.0
```

Deliberately **not** a dependency on the `webex` aggregator package — see §4.2 for why.

---

## 3. Changes to shared/root files

| File | Change |
|---|---|
| `package.json` (root) | Added `"plugins/webex-meeting-join"` to `workspaces`; added `plugins/webex-meeting-join/*.test.cjs` to the `test` script glob |
| `config/openclaw.json` | Added `"plugins/webex-meeting-join"` to `plugins.load.paths`; added `"webex-meeting-join": { "enabled": true }` to `plugins.entries` |
| `.env.example` | Documented new vars: `WEBEX_MEETING_WEBHOOK_URL` (required), `WEBEX_MEETING_ACCESS_TOKEN`/`WEBEX_MEETING_REFRESH_TOKEN`/`WEBEX_MEETING_CLIENT_ID`/`WEBEX_MEETING_CLIENT_SECRET` (optional, fall back to the existing `WEBEX_ACCESS_TOKEN` family), `WEBEX_MEETING_POLL_INTERVAL_MS`/`WEBEX_MEETING_JOIN_TIMEOUT_MS` (optional tuning) |

No changes were made to `openclaw.Dockerfile` — the plugin reuses the container's existing `PLAYWRIGHT_BROWSERS_PATH` Chromium cache (already installed for `lib`'s own Playwright dependency), and `esbuild`'s native binaries install via `optionalDependencies`, which works under the Dockerfile's `npm install --workspaces --ignore-scripts`.

---

## 4. Failure modes

### 4.A. Originally identified during the research phase (before implementation)

| # | Failure mode | Resolution | Where |
|---|---|---|---|
| 1 | Missed `meetings/started` webhook (delivery failure, gateway downtime) | Startup reconciliation sweep + periodic poll (default 5 min) list active meetings via REST and join any missed one | `orchestrator.js` → `reconcile()`, `startPolling()`; invoked from `index.js`'s `gateway_start` handler |
| 2 | `roomId`/`spaceId` no longer valid as an SDK join destination (Webex error 30105, Unified Space Meetings migration) | `resolveDestination()` only ever returns `sipUrl` or `meetingId`, both resolved via REST; never constructs a roomId-based destination | `meetings.js` → `resolveDestination()` |
| 3 | Duplicate/retried webhook delivery → double-join or double-leave race | Per-meetingId concurrency lock coalesces concurrent operations; idempotency checks (`isJoined`/`isSuppressed`) before attempting | `state.js` → `MeetingState.withLock()`; `orchestrator.js` → `tryJoin()`/`tryLeave()` |
| 4 | Token expiry (~14-day Webex OAuth tokens) | Proactive refresh every 12 days, matching the existing webex plugin's cadence | `index.js` → `TOKEN_REFRESH_INTERVAL_MS` timer calling `tokenStore.refresh()` |
| 5 | `meeting.join()` failing (password/CAPTCHA/host-admission required) | Join wrapped in a timeout (`WEBEX_MEETING_JOIN_TIMEOUT_MS`, default 20s) and try/catch; posts a "couldn't join, please join manually" fallback message to the space instead of hanging indefinitely or crashing the process | `browser-runtime.js` → `withTimeout()`; `orchestrator.js` → `tryJoin()`'s catch block |
| 6 | Bot process restart mid-meeting | Startup reconciliation rediscovers active meetings from Webex's own REST state — no on-disk state file that can go stale or get corrupted | `orchestrator.js` → `reconcile()` called once at startup in `index.js` |
| 7 | Meeting ends while local state thinks it's still joined | `meetings/ended` webhook unconditionally clears local state | `orchestrator.js` → `handleMeetingEnded()` |
| 8 | Concurrent "leave meeting" requests, or "leave" said when the bot isn't in a meeting | Command handler checks current joined state first and replies gracefully rather than erroring | `orchestrator.js` → `handleMessageCreated()` |

### 4.B. Discovered during implementation (not anticipated in the research phase)

**4.B.1 — Redundant REST fetch causing a spurious multi-second delay**

`tryJoin()` originally took a bare `meetingId` and re-fetched the meeting's details from `/meetings/{id}` internally — even when the caller (`handleMeetingStarted` or `reconcile()`) had *already* fetched the full meeting object from its own REST call one line earlier. This surfaced as a real bug (not just a test artifact): the reconcile-path unit test timed out at ~3000ms, exactly matching `fetchMeetingWithRetry`'s retry backoff (3 attempts × ~1500ms), because the redundant second fetch had no route configured.
**Resolution**: `tryJoin(meeting)` now takes the already-resolved meeting object directly; both call sites pass their own fetched object instead of a bare ID. Removes an unnecessary REST round-trip per join attempt in production too — one less way for a join to fail on a slow/flaky REST call.
**File**: `orchestrator.js` (`tryJoin`, `handleMeetingStarted`, `reconcile`)

**4.B.2 — The full `webex` npm aggregator cannot be bundled for a browser at all**

Initial implementation used `require('webex')` (the standard top-level package shown in Webex's own sample app). Bundling it with esbuild for a browser target failed with 45 errors — `Could not resolve "querystring"/"util"/"url"/"stream"/"os"` — because several of `webex`'s internal modules `require()` Node built-ins directly, despite the package being marketed as a "Browser SDK." Confirmed by actually running `esbuild.buildSync()` against `browser-entry.js` (not from documentation).
**Investigation**: reading `node_modules/webex/dist/webex.js` showed it `require()`s ~20 plugins as side effects, including `@webex/plugin-encryption` and `@webex/contact-center` — neither needed for meeting join/leave.
**Resolution**: `browser-entry.js` no longer requires the `webex` aggregator. It requires only `@webex/plugin-meetings` and its own actual dependencies (cross-checked against `@webex/plugin-meetings/package.json`'s `dependencies` field): `@webex/internal-plugin-device`, `-conversation`, `-llm`, `-mercury`, `-metrics`, `-support`, `-user`, `-voicea`, `@webex/plugin-people`, `@webex/plugin-rooms`, plus `@webex/webex-core` directly (`WebexCore.extend({ webex: true })`, replicating the aggregator's `Webex.init()` merge logic locally). This dropped 37 npm packages from `node_modules` on reinstall (encryption/contact-center/teams/messaging/webhooks plugins and their transitive deps).
**Files**: `browser-entry.js` (rewritten require list + local `Webex.init` equivalent), `package.json` (dependency list changed from `webex` to the specific `@webex/*` packages above, all pinned to `3.12.0`)

**4.B.3 — `jsonwebtoken`/`jws` still break bundling after 4.B.2's fix**

Even after removing the aggregator, `@webex/webex-core`'s `credentials.js` unconditionally `require()`s `jsonwebtoken` (used to inspect token expiry, unrelated to our OAuth access-token flow). `jsonwebtoken`'s `jws` dependency's `data-stream.js`/`sign-stream.js` call `util.inherits(Ctor, Stream)` against the `stream` polyfill provided by `esbuild-plugin-polyfill-node`; the polyfill's `Stream` export isn't a constructor `util.inherits` accepts, throwing `TypeError: Object prototype may only be an Object or null: undefined` at bundle-evaluation time — before any of our own code runs. Confirmed via full stack trace from an actual headless-Chromium `pageerror` event (`jws/lib/data-stream.js` → `util.inherits` → `Object.create`).
**Resolution**: aliased `jsonwebtoken` to a local stub (loads safely; `decode()` returns `null` — matching real `jsonwebtoken`'s behavior for a non-JWT opaque token like ours; `sign`/`verify` throw clearly if ever actually invoked, which they shouldn't be for an access-token-only flow).
**Files**: `browser-stubs/jsonwebtoken.js` (new stub); `browser-runtime.js` (`esbuild.build()`'s `alias` option)

**4.B.4 — `node-jose` pulled in transitively via an undeclared package coupling**

After 4.B.3's fix, a *different* crash appeared: `TypeError: helpers.nodeCrypto.getHashes is not a function` inside `node_modules/node-jose/lib/algorithms/ecdsa.js`, called from `node-jose/lib/jwk/keystore.js`. `getHashes()` is a Node-only `crypto` API with no Web Crypto equivalent.
**Investigation**: grepping every required package's `package.json` found none declared `node-jose` directly. Grepping each required package's compiled `dist/` output found the actual source: `@webex/internal-plugin-conversation/dist/index.js` unconditionally `require()`s `@webex/internal-plugin-encryption` — an undeclared runtime coupling not listed in `internal-plugin-conversation`'s own `package.json` dependencies — which in turn depends on `node-jose`.
**Resolution**: since meeting join/leave never touches Teams-space message-content encryption (KMS/JOSE is a completely separate data plane from meeting media/signaling), aliased `node-jose` to a local stub — a `Proxy` that lazily throws a clear error only if a property/method on it is genuinely invoked, so it doesn't need to track `node-jose`'s exact API surface up front and fails loudly (not silently) if this assumption is ever wrong.
**Files**: `browser-stubs/node-jose.js` (new stub); `browser-runtime.js` (`alias` option, `node-jose` entry)

**4.B.5 — Bare `global` reference crashes in a real browser page**

After 4.B.4's fix, the bundle loaded further but threw `ReferenceError: global is not defined` — some dependency in the tree checks for a Node-style `global` object directly (not via `require()`-ing a builtin module, which `esbuild-plugin-polyfill-node` does handle).
**Resolution**: added `define: { global: 'globalThis' }` to the esbuild build config.
**File**: `browser-runtime.js` (`ensureBundle()`'s `esbuild.build()` call)

**4.B.6 — esbuild's `plugins` option is incompatible with the synchronous build API**

Initial bundling used `esbuild.buildSync()` for simplicity. Adding `esbuild-plugin-polyfill-node` (required for 4.B.2 onward) failed immediately with `Cannot use plugins in synchronous API calls`.
**Resolution**: switched `ensureBundle()` to the async `esbuild.build()` API; `browser-runtime.js`'s caller (`ensureBrowserAlive()`) already runs in an async context, so this required no further changes beyond adding `await`.
**File**: `browser-runtime.js`

---

## 5. Testing performed

**Unit tests** — 38 tests across 7 files (`node --test *.test.cjs`, all passing):
`config.test.cjs`, `commands.test.cjs`, `state.test.cjs`, `meetings.test.cjs`, `webhook-router.test.cjs`, `token.test.cjs`, `orchestrator.test.cjs`. These cover every piece of logic except the actual headless-browser/SDK layer, which is injected as a fake in `orchestrator.test.cjs` (`fakeBrowserRuntime()`) specifically so the webhook/state/command logic is testable without a live Webex account. Full repo suite (`npm test`, 54 tests total including pre-existing plugins) passes with no regressions.

**Live smoke tests performed against the real bundling/browser pipeline** (not mocked, but without a real Webex account — see §6):
1. `esbuild.build()` on `browser-entry.js` against the real, installed `@webex/*` packages — confirmed it bundles without errors after fixes 4.B.2–4.B.6 (final bundle: ~9 MB, `.generated/browser-entry.bundle.js`, gitignored).
2. Loaded the resulting bundle in a real headless Chromium page via Playwright (`chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] })`) — confirmed `window.__webexMeetingJoin` exposes `init`/`join`/`leave`/`syncActive` with no page-load errors.
3. Called `window.__webexMeetingJoin.init('fake-token-for-smoke-test')` in that page — confirmed it gets past all module-loading and into the SDK's own `webex.meetings.register()` runtime logic (see §6 for where it fails, and why that's expected with a placeholder token).

---

## 6. What remains unverified

No real Webex account/meeting was available in this environment, so end-to-end join/leave against a live meeting was **not** exercised. Specifically unverified:

- Calling `init()` with a real (not placeholder) access token — the placeholder-token smoke test failed inside an internal metrics call (`Metrics2.sendBehavioralMetric` reading `.internal` off `undefined`), consistent with device registration silently failing on invalid credentials before a telemetry call assumes it succeeded. **If this exact error recurs with a real token**, it points to an SDK init-sequencing gap (e.g. needing to await device/mercury registration before calling `meetings.register()`) rather than a bundling problem — a concrete, narrow next debugging step rather than an open unknown.
- `resolveDestination()`'s choice of `type: undefined` when only a bare `meetingId` (no `sipUrl`) is available — the exact `type` string `webex.meetings.create()` expects in that case wasn't confirmed against live docs (Webex's own sample app uses a UI dropdown without enumerating every value); `undefined` follows the sample's pattern of letting the SDK infer it.
- Whether `meeting.join()` without a subsequent `meeting.addMedia()` call (phase 1 has no audio/video) is accepted by Webex's Locus signaling the same way a real full client's join would be.
- Webhook payload shapes for `meetings/started`/`meetings/ended`/`messages/created` are assumed to carry `data.id` (consistent with the existing `plugins/webex/meeting-transcript.js`'s documented assumption for `meetingTranscripts` webhooks) but were not confirmed against a real delivered payload.

These are called out explicitly in `plugins/webex-meeting-join/README.md`'s "Known limitations" section as well.

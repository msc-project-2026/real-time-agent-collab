// Self-contained OpenClaw plugin: auto-joins Webex space meetings (instant
// and scheduled) via the Webex Browser SDK when a `meetings/started` webhook
// fires, and leaves on a chat command. Requires no other OpenClaw plugin or
// `lib` module — copy this folder + set its env vars to port it.
'use strict';

const { getConfig } = require('./config');
const { createTokenStore } = require('./token');
const { ensureWebhooks, deregisterWebhooks } = require('./webhook-subscriptions');
const { createWebhookRouter, ROUTE_PREFIX } = require('./webhook-router');
const { createBrowserRuntime } = require('./browser-runtime');
const { createOrchestrator } = require('./orchestrator');

const TOKEN_REFRESH_INTERVAL_MS = 12 * 24 * 60 * 60 * 1000; // Webex tokens last ~14 days

function register(api) {
  let cfg;
  try {
    cfg = getConfig();
  } catch (err) {
    api.logger?.warn?.(`[webex-meeting-join] disabled: ${err.message}`);
    return;
  }

  const log = api.logger;
  const tokenStore = createTokenStore(cfg);
  const browserRuntime = createBrowserRuntime({ log, joinTimeoutMs: cfg.joinTimeoutMs });
  const orchestrator = createOrchestrator({ cfg, tokenStore, browserRuntime, log });

  let refreshInterval = null;

  api.registerHttpRoute({
    path: `${ROUTE_PREFIX}/`,
    auth: 'plugin',
    match: 'prefix',
    handler: createWebhookRouter({
      webhookSecret: cfg.webhookSecret,
      log,
      handlers: new Map([
        ['/meetings-started', (payload) => orchestrator.handleMeetingStarted(payload)],
        ['/meetings-ended', (payload) => orchestrator.handleMeetingEnded(payload)],
        ['/messages-created', (payload) => orchestrator.handleMessageCreated(payload)],
      ]),
    }),
  });

  api.on('gateway_start', async () => {
    log?.info?.('[webex-meeting-join] starting');

    if (cfg.canRefreshMeetingToken) {
      try {
        await tokenStore.refresh();
        log?.info?.('[webex-meeting-join] meeting-account token refreshed on start');
      } catch (err) {
        log?.warn?.(`[webex-meeting-join] startup token refresh failed, using existing token: ${err?.message}`);
      }
      refreshInterval = setInterval(async () => {
        try {
          await tokenStore.refresh();
          log?.info?.('[webex-meeting-join] meeting-account token refreshed');
        } catch (err) {
          log?.warn?.(`[webex-meeting-join] scheduled token refresh failed: ${err?.message}`);
        }
      }, TOKEN_REFRESH_INTERVAL_MS);
    }

    await ensureWebhooks({
      meetingToken: tokenStore.getToken(),
      botToken: cfg.botToken,
      webhookBaseUrl: cfg.webhookBaseUrl,
      webhookSecret: cfg.webhookSecret,
    });
    log?.info?.('[webex-meeting-join] webhooks registered');

    await orchestrator.start();

    // Fallback #1: catch any meeting already in progress when the gateway
    // starts (process restart, or the started-webhook fired while we were
    // down). Fallback #2: keep sweeping periodically in case the webhook
    // subscription itself silently breaks later (e.g. deleted by an admin).
    await orchestrator.reconcile().catch((err) =>
      log?.warn?.(`[webex-meeting-join] startup reconciliation failed: ${err?.message}`)
    );
    orchestrator.startPolling();

    log?.info?.(`[webex-meeting-join] ready at ${ROUTE_PREFIX}/{meetings-started,meetings-ended,messages-created}`);
  }, { timeoutMs: 60_000 });

  api.on('gateway_stop', async () => {
    log?.info?.('[webex-meeting-join] stopping');
    if (refreshInterval) clearInterval(refreshInterval);
    await orchestrator.dispose();
    await deregisterWebhooks({
      meetingToken: tokenStore.getToken(),
      botToken: cfg.botToken,
      webhookBaseUrl: cfg.webhookBaseUrl,
      webhookSecret: cfg.webhookSecret,
    }).catch((err) => log?.warn?.(`[webex-meeting-join] webhook deregister failed: ${err?.message}`));
  });
}

module.exports = register;
module.exports.default = register;

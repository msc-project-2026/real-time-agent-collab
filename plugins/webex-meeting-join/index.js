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
const { createMeetingMinutesManager } = require('./meeting-minutes');
const { webexFetch } = require('./api');

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
  const tokenStore = createTokenStore(cfg, log);

  let transcription = null;
  let meetingAgent = null;
  if (cfg.transcription.enabled) {
    const { createMeetingAgent } = require('./meeting-agent');
    meetingAgent = createMeetingAgent({
      runtime: api.runtime,
      postToSpace: (roomId, markdown) =>
        webexFetch(cfg.botToken, '/messages', { method: 'POST', body: { roomId, markdown } }),
      gateThreshold: cfg.transcription.gateThreshold,
      addressedGateThreshold: cfg.transcription.addressedGateThreshold,
      minTurnWords: cfg.transcription.minTurnWords,
      log,
    });
    const common = { log, onTurn: (turn) => meetingAgent.handleTurn(turn) };
    if (cfg.transcription.provider === 'deepgram') {
      const { createTranscriptionManager } = require('./transcription');
      transcription = createTranscriptionManager({
        ...common,
        apiKey: cfg.transcription.apiKey,
        baseUrl: cfg.transcription.baseUrl,
        model: cfg.transcription.model,
        sampleRate: cfg.transcription.sampleRate,
        eotThreshold: cfg.transcription.eotThreshold,
        eotTimeoutMs: cfg.transcription.eotTimeoutMs,
      });
    } else {
      const { createWebexTranscriptionManager } = require('./webex-transcription');
      transcription = createWebexTranscriptionManager(common);
    }
    log?.info?.(`[webex-meeting-join] live transcription enabled (provider=${cfg.transcription.provider})`);
  } else {
    log?.info?.('[webex-meeting-join] live transcription disabled');
  }

  // Post-meeting minutes use Webex's completed transcript independently of the
  // selected live provider.
  const meetingMinutes = cfg.minutes.enabled
    ? createMeetingMinutesManager({ runtime: api.runtime, tokenStore, config: cfg.minutes, log })
    : null;
  log?.info?.(
    cfg.minutes.enabled
      ? '[webex-meeting-join] post-meeting minutes enabled (transcript webhook + ended-meeting recovery)'
      : '[webex-meeting-join] post-meeting minutes disabled'
  );

  const browserRuntime = createBrowserRuntime({
    log,
    joinTimeoutMs: cfg.joinTimeoutMs,
    executablePath: cfg.browserExecutablePath,
    onAudioData: cfg.transcription.provider === 'deepgram'
      ? (meetingId, base64) => transcription.pushPcm(meetingId, base64)
      : null,
    onCaptions: cfg.transcription.provider === 'webex'
      ? (meetingId, payload) => transcription.pushCaptions(meetingId, payload)
      : null,
  });
  const orchestrator = createOrchestrator({
    cfg,
    tokenStore,
    browserRuntime,
    log,
    transcription,
    meetingAgent,
    meetingMinutes,
  });

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
        ['/transcripts-created', (payload) => orchestrator.handleTranscriptCreated(payload)],
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
      minutesEnabled: cfg.minutes.enabled,
      log,
    });
    log?.info?.('[webex-meeting-join] webhooks registered');

    await meetingMinutes?.resumePending().catch((err) =>
      log?.warn?.(`[webex-meeting-join] failed to resume transcript recovery jobs: ${err?.message ?? err}`)
    );

    try {
      await orchestrator.start();
    } catch (err) {
      // Keep the webhook route and reconciliation fallback alive. The browser
      // runtime discards a partially initialized page and retries cleanly on
      // the next meeting/poll instead of permanently disabling the plugin.
      log?.warn?.(`[webex-meeting-join] initial setup failed; identities/SDK will retry automatically: ${err?.message ?? err}`);
    }

    // Fallback #1: catch any meeting already in progress when the gateway
    // starts (process restart, or the started-webhook fired while we were
    // down). Fallback #2: keep sweeping periodically in case the webhook
    // subscription itself silently breaks later (e.g. deleted by an admin).
    await orchestrator.reconcile().catch((err) =>
      log?.warn?.(`[webex-meeting-join] startup reconciliation failed: ${err?.message}`)
    );
    orchestrator.startPolling();

    log?.info?.(
      `[webex-meeting-join] ready at ${ROUTE_PREFIX}/{meetings-started,meetings-ended,transcripts-created,messages-created}`
    );
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
      minutesEnabled: cfg.minutes.enabled,
      log,
    }).catch((err) => log?.warn?.(`[webex-meeting-join] webhook deregister failed: ${err?.message}`));
  });
}

module.exports = register;
module.exports.default = register;

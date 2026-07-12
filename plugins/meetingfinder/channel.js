// meetingfinder plugin object.

'use strict';

const {
  getAccessToken,
  setAccessToken,
  refreshAccessToken,
  ensureWebhook,
  deregisterWebhooks,
} = require('./token');
const { handleInbound } = require('./inbound');
const { targets, normPath } = require('../webex/webhook');

const DEFAULT_ACCOUNT = 'default';

function getSection(cfg) {
  return cfg?.channels?.meetingfinder ?? {};
}

function listAccountIds(cfg) {
  return getSection(cfg)?.accessToken || getSection(cfg)?.token ? [DEFAULT_ACCOUNT] : [];
}

function resolveAccount(cfg, accountId = DEFAULT_ACCOUNT) {
  const section = getSection(cfg);
  if (accountId !== DEFAULT_ACCOUNT || !section) {
    return { accountId, enabled: false, configured: false, config: {} };
  }

  const config = {
    token: section.token ?? '',
    accessToken: section.accessToken,
    refreshToken: section.refreshToken,
    clientId: section.clientId,
    clientSecret: section.clientSecret,
    webhookUrl: section.webhookUrl ?? '',
    webhookSecret: section.webhookSecret,
    roomIds: section.roomIds ?? [],
  };

  return {
    accountId,
    enabled: section.enabled !== false,
    configured: Boolean(config.accessToken || config.token),
    config,
  };
}

const meetingfinderPlugin = {
  id: 'meetingfinder',
  meta: {
    id: 'meetingfinder',
    label: 'Meeting Finder',
    selectionLabel: 'Webex Meeting Finder',
    docsPath: '/channels/meetingfinder',
    blurb: 'Resolves join links when meetings start in watched Webex spaces.',
    order: 76,
    aliases: [],
  },
  capabilities: { chatTypes: [], threads: false, media: false },
  reload: { configPrefixes: ['channels.meetingfinder'] },

  config: {
    listAccountIds,
    resolveAccount,
    defaultAccountId: () => DEFAULT_ACCOUNT,
    isConfigured: (account) => account.configured,
    describeAccount: (account) => ({
      accountId: account.accountId,
      enabled: account.enabled,
      configured: account.configured,
      roomIds: account.config.roomIds ?? [],
    }),
  },

  gateway: {
    startAccount: async (ctx) => {
      const { account, log, setStatus } = ctx;
      const cfg = account.config;

      setStatus?.({ accountId: account.accountId });
      log?.info?.(`[meetingfinder:${account.accountId}] starting`);

      setAccessToken(cfg.accessToken ?? null);

      let refreshInterval = null;
      if (cfg.accessToken) {
        const TWELVE_DAYS_MS = 12 * 24 * 60 * 60 * 1000;
        refreshInterval = setInterval(async () => {
          try {
            setAccessToken(await refreshAccessToken(cfg));
            log?.info?.(`[meetingfinder:${account.accountId}] access token refreshed`);
          } catch (err) {
            log?.warn?.(
              `[meetingfinder:${account.accountId}] token refresh failed: ${err?.message}`
            );
          }
        }, TWELVE_DAYS_MS);
      }

      await ensureWebhook(cfg);
      log?.info?.(`[meetingfinder:${account.accountId}] meetings webhook registered`);

      const webhookPath = normPath(`/webhooks/meetingfinder/${account.accountId}`);
      targets.set(webhookPath, {
        account,
        handle: (payload) => handleInbound(payload, { cfg, log }),
      });
      log?.info?.(`[meetingfinder:${account.accountId}] ready at ${webhookPath}`);

      try {
        await new Promise(() => {}); // never resolves
      } finally {
        if (refreshInterval) clearInterval(refreshInterval);
        log?.info?.(`[meetingfinder:${account.accountId}] stopping`);
        targets.delete(webhookPath);
        await deregisterWebhooks(cfg).catch((err) =>
          log?.warn?.(
            `[meetingfinder:${account.accountId}] webhook deregister failed: ${err?.message}`
          )
        );
      }
    },
  },
};

module.exports = { meetingfinderPlugin, DEFAULT_ACCOUNT };

// Webex channel plugin object implementing the OpenClaw channel contract.
'use strict';

const { WEBEX_API, webexFetch } = require('./api');
const {
  getAccessToken,
  setAccessToken,
  refreshAccessToken,
  ensureWebhook,
  deregisterWebhooks,
  ensureMeetingWebhook,
  deregisterMeetingWebhook,
} = require('./token');
const { buildMsgBody } = require('./send');
const { handleInbound } = require('./inbound');
const { targets, normPath } = require('./webhook');
const { joinMeeting, leaveMeeting } = require('./meetingRuntime');

const DEFAULT_ACCOUNT = 'default';

function redactAccount(a) {
  if (!a) return null;
  return {
    ...a,
    token: a.token ? '[present]' : '[missing]',
    accessToken: a.accessToken ? '[present]' : '[missing]',
    refreshToken: a.refreshToken ? '[present]' : '[missing]',
    clientSecret: a.clientSecret ? '[present]' : '[missing]',
  };
}

function getWebexSection(cfg) {
  return cfg?.channels?.webex ?? {};
}

function listAccountIds(cfg) {
  const section = getWebexSection(cfg);

  if (!section?.token) {
    console.log('[webex] listAccountIds:', {
      cfgKeys: Object.keys(cfg ?? {}),
      sectionKeys: Object.keys(section ?? {}),
      tokenPresent: Boolean(section?.token),
      accountIds: section?.accounts ? Object.keys(section.accounts) : [],
    });
    return [];
  }

  const ids = [DEFAULT_ACCOUNT];

  if (section.accounts) {
    for (const id of Object.keys(section.accounts)) {
      if (id !== DEFAULT_ACCOUNT) ids.push(id);
    }
  }

  return ids;
}

function resolveAccount(cfg, accountId = DEFAULT_ACCOUNT) {
  const section = getWebexSection(cfg);

  const named =
    accountId !== DEFAULT_ACCOUNT ? section.accounts?.[accountId] : null;

  const resolved = named
    ? {
        token: named.token ?? section.token ?? '',
        webhookUrl: named.webhookUrl ?? section.webhookUrl ?? '',
        webhookSecret: named.webhookSecret ?? section.webhookSecret,
        dmPolicy: named.dmPolicy ?? section.dmPolicy ?? 'deny',
        allowFrom: named.allowFrom ?? section.allowFrom ?? [],
        accessToken: named.accessToken ?? section.accessToken,
        clientId: named.clientId ?? section.clientId,
        clientSecret: named.clientSecret ?? section.clientSecret,
        refreshToken: named.refreshToken ?? section.refreshToken,
      }
    : accountId === DEFAULT_ACCOUNT
      ? {
          token: section.token ?? '',
          webhookUrl: section.webhookUrl ?? '',
          webhookSecret: section.webhookSecret,
          dmPolicy: section.dmPolicy ?? 'deny',
          allowFrom: section.allowFrom ?? [],
          accessToken: section.accessToken,
          clientId: section.clientId,
          clientSecret: section.clientSecret,
          refreshToken: section.refreshToken,
        }
      : null;

  if (!resolved) {
    console.log('[webex] resolveAccount:', {
      accountId,
      cfgKeys: Object.keys(cfg ?? {}),
      sectionKeys: Object.keys(section ?? {}),
      resolved: redactAccount(resolved),
      configured: Boolean(resolved?.token),
      enabled: section.enabled !== false,
    });
    return { accountId, enabled: false, configured: false, config: {} };
  }

  return {
    accountId,
    enabled: section.enabled !== false,
    configured: Boolean(resolved.token),
    config: resolved,
  };
}

const webexPlugin = {
  id: 'webex',
  meta: {
    id: 'webex',
    label: 'Webex',
    selectionLabel: 'Cisco Webex',
    docsPath: '/channels/webex',
    blurb: 'Cisco Webex messaging via bot webhooks.',
    order: 75,
    aliases: ['cisco-webex'],
  },
  capabilities: { chatTypes: ['direct', 'group'], threads: true, media: false },
  reload: { configPrefixes: ['channels.webex'] },

  config: {
    listAccountIds,
    resolveAccount,
    defaultAccountId: () => DEFAULT_ACCOUNT,
    isConfigured: (account) => account.configured,
    describeAccount: (account) => ({
      accountId: account.accountId,
      enabled: account.enabled,
      configured: account.configured,
      baseUrl: WEBEX_API,
    }),
  },

  security: {
    resolveDmPolicy: ({ account }) => ({
      // OpenClaw uses 'allowlist' internally; config uses 'allowlisted'
      policy:
        account.config.dmPolicy === 'allowlisted'
          ? 'allowlist'
          : (account.config.dmPolicy ?? 'deny'),
      allowFrom: account.config.allowFrom ?? [],
      policyPath: 'channels.webex.dmPolicy',
      allowFromPath: 'channels.webex.allowFrom',
      approveHint: 'Add email or person ID to channels.webex.allowFrom',
      normalizeEntry: (raw) => String(raw).trim().toLowerCase(),
    }),
  },

  threading: {
    resolveReplyToMode: () => 'off',
    buildToolContext: ({ context, hasRepliedRef }) => ({
      currentChannelId: context.To?.trim() || undefined,
      currentThreadTs:
        context.MessathreadId != null
          ? String(context.MessageThreadId)
          : context.ReplyToId,
      hasRepliedRef,
    }),
  },

  messaging: {
    normalizeTarget: (raw) => {
      let t = String(raw ?? '').trim();
      if (t.toLowerCase().startsWith('webex:')) t = t.slice(6).trim();
      return t || undefined;
    },
    targetResolver: {
      looksLikeId: (raw) => {
        const t = String(raw ?? '')
          .trim()
          .toLowerCase();
        return t.startsWith('y2lzy29zcgfyazovl3') || t.includes('@');
      },
      hint: '<roomId|personId|email>',
    },
  },

  outbound: {
    deliveryMode: 'direct',
    textChunkLimit: 7000, // Webex max is 7439 bytes

    sendText: async ({
      cfg,
      to,
      text,
      account,
      accountId = DEFAULT_ACCOUNT,
      replyToId,
    }) => {
      const resolvedAccount = account ?? resolveAccount(cfg, accountId);

      if (!resolvedAccount?.config?.token) {
        console.log('[webex] sendText failed to resolve account:', {
          to,
          textLength: text?.length ?? 0,
          accountId,
          accountPresent: Boolean(account),
          resolvedAccountPresent: Boolean(resolvedAccount),
          configPresent: Boolean(resolvedAccount?.config),
          tokenPresent: Boolean(resolvedAccount?.config?.token),
        });
        throw new Error(
          'Webex send failed: missing resolvedAccount.config.token'
        );
      }

      const msg = await webexFetch(resolvedAccount.config.token, '/messages', {
        method: 'POST',
        body: buildMsgBody(to, { text }, replyToId),
      });

      return { channel: 'webex', messageId: msg.id, roomId: msg.roomId };
    },

    sendMedia: async ({
      cfg,
      to,
      text,
      mediaUrl,
      account,
      accountId = DEFAULT_ACCOUNT,
      replyToId,
    }) => {
      const resolvedAccount = account ?? resolveAccount(cfg, accountId);

      if (!resolvedAccount?.config?.token) {
        console.log('[webex] sendMedia failed to resolve account:', {
          to,
          textLength: text?.length ?? 0,
          mediaUrlPresent: Boolean(mediaUrl),
          accountId,
          accountPresent: Boolean(account),
          resolvedAccountPresent: Boolean(resolvedAccount),
          configPresent: Boolean(resolvedAccount?.config),
          tokenPresent: Boolean(resolvedAccount?.config?.token),
        });
        throw new Error(
          'Webex sendMedia failed: missing resolvedAccount.config.token'
        );
      }

      const msg = await webexFetch(resolvedAccount.config.token, '/messages', {
        method: 'POST',
        body: buildMsgBody(
          to,
          { text, files: mediaUrl ? [mediaUrl] : undefined },
          replyToId
        ),
      });

      return { channel: 'webex', messageId: msg.id, roomId: msg.roomId };
    },
  },

  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT,
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    },
    collectStatusIssues: (accounts) =>
      accounts.flatMap((a) => {
        const err = typeof a.lastError === 'string' ? a.lastError.trim() : '';
        return err
          ? [
              {
                channel: 'webex',
                accountId: a.accountId,
                kind: 'runtime',
                message: `Channel error: ${err}`,
              },
            ]
          : [];
      }),
    buildAccountSnapshot: ({ account, runtime, probe }) => ({
      accountId: account.accountId,
      enabled: account.enabled,
      configured: account.configured,
      baseUrl: WEBEX_API,
      running: runtime?.running ?? false,
      lastStartAt: runtime?.lastStartAt ?? null,
      lastStopAt: runtime?.lastStopAt ?? null,
      lastError: runtime?.lastError ?? null,
      probe,
      lastProbeAt: runtime?.lastProbeAt ?? null,
    }),
    probeAccount: async ({ account, timeoutMs }) => {
      if (!account.configured)
        return { ok: false, error: 'Not configured', elapsedMs: 0 };
      const start = Date.now();
      try {
        const res = await fetch(`${WEBEX_API}/people/me`, {
          headers: {
            Authorization: `Bearer ${account.config.token}`,
          },
          ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
        });
        const elapsedMs = Date.now() - start;
        return res.ok
          ? { ok: true, elapsedMs }
          : { ok: false, error: `HTTP ${res.status}`, elapsedMs };
      } catch (err) {
        return {
          ok: false,
          error: err?.message ?? String(err),
          elapsedMs: Date.now() - start,
        };
      }
    },
  },

  gateway: {
    startAccount: async (ctx) => {
      const { account, log, setStatus } = ctx;
      const cfg = account.config;

      setStatus?.({ accountId: account.accountId, baseUrl: WEBEX_API });
      log?.info?.(`[webex:${account.accountId}] starting`);

      // Initialise OAuth access token (used for all API calls except sending replies)
      setAccessToken(cfg.accessToken ?? null);

      // Resolve bot identity so we can filter self-messages and detect mentions
      const botInfo = await webexFetch(cfg.token, '/people/me');
      const botId = botInfo.id;
      log?.info?.(`[webex:${account.accountId}] bot id=${botId}`);

      // Refresh access token every 12 days (tokens last ~14 days); Webex auto-renews the refresh token.
      let refreshInterval = null;
      if (cfg.accessToken) {
        const TWELVE_DAYS_MS = 12 * 24 * 60 * 60 * 1000;
        refreshInterval = setInterval(async () => {
          try {
            setAccessToken(await refreshAccessToken(cfg));
            log?.info?.(`[webex:${account.accountId}] access token refreshed`);
          } catch (err) {
            log?.warn?.(
              `[webex:${account.accountId}] token refresh failed: ${err?.message}`
            );
          }
        }, TWELVE_DAYS_MS);
      }

      // Register (or refresh) the Webex message webhook for this account
      await ensureWebhook(cfg);
      log?.info?.(`[webex:${account.accountId}] Webex message webhook registered`);

      // Register (or refresh) the meeting started/ended webhooks — same
      // targetUrl as the message webhook (see token.js), so both land on
      // the single HTTP target registered below.
      // Non-fatal: if the account lacks meeting-webhook permissions (e.g.
      // insufficient OAuth scopes or no Meetings license), log and continue
      // rather than taking down message handling, which already works.
      try {
        await ensureMeetingWebhook(cfg);
        log?.info?.(`[webex:${account.accountId}] Webex meeting webhooks registered`);
      } catch (err) {
        log?.warn?.(
          `[webex:${account.accountId}] meeting webhook registration failed (meeting-join feature disabled): ${err?.message}`
        );
      }

      // Register the single HTTP dispatch target for incoming POSTs —
      // handles both `messages` and `meetings` payloads, branching on
      // payload.resource.
      const webhookPath = normPath(`/webhooks/webex/${account.accountId}`);
      targets.set(webhookPath, {
        account,
        handle: async (payload) => {
          if (payload.resource === 'messages') {
            return handleInbound(payload, { botId, cfg, account, log });
          }

          if (payload.resource === 'meetings') {
            const meetingId = payload.data?.id;
            if (!meetingId) return;

            if (payload.event === 'started') {
              await joinMeeting({
                meetingId,
                destination: meetingId,
                accessToken: getAccessToken() ?? cfg.token,
                cfg,
                account,
                log,
              });
            } else if (payload.event === 'ended') {
              await leaveMeeting(meetingId);
              log?.info?.(`[webex:${account.accountId}] left meetingId=${meetingId} (meeting ended)`);
            }
          }
        },
      });
      log?.info?.(`[webex:${account.accountId}] ready at ${webhookPath}`);

      // The channel must stay alive until the gateway stops it.
      // On shutdown the finally block deregisters the target and Webex webhooks.
      try {
        await new Promise(() => {}); // never resolves
      } finally {
        if (refreshInterval) clearInterval(refreshInterval);
        log?.info?.(`[webex:${account.accountId}] stopping`);
        targets.delete(webhookPath);
        await deregisterWebhooks(cfg).catch((err) =>
          log?.warn?.(
            `[webex:${account.accountId}] webhook deregister failed: ${err?.message}`
          )
        );
        await deregisterMeetingWebhook(cfg).catch((err) =>
          log?.warn?.(
            `[webex:${account.accountId}] meeting webhook deregister failed: ${err?.message}`
          )
        );
      }
    },
  },
};

module.exports = { webexPlugin, DEFAULT_ACCOUNT };
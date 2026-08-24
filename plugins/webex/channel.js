// ********* CHANNEL.JS *********
'use strict';

// Webex channel plugin object implementing the OpenClaw channel contract.

const { WEBEX_API, webexFetch } = require('./api');
const {
  ensureWebhooks,
  deregisterWebhooks,
} = require('./webhook/registration');
const {
  getAccessToken,
  setAccessToken,
  refreshAccessToken,
} = require('./token');
const { targets, normPath } = require('./webhook/router');
const { handleInboundWebexWebhook } = require('./inbound');
const { sendWebexMessage } = require('./send');

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
        botWebhookUrl: named.botWebhookUrl ?? section.botWebhookUrl ?? '',
        oauthWebhookUrl: named.oauthWebhookUrl ?? section.oauthWebhookUrl ?? '',
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
          botWebhookUrl: section.botWebhookUrl ?? '',
          oauthWebhookUrl: section.oauthWebhookUrl ?? '',
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

async function cleanupAccountResources({
  account,
  cfg,
  log,
  refreshInterval,
  botWebhookPath,
  oauthWebhookPath,
}) {
  if (refreshInterval) clearInterval(refreshInterval);
  log?.info?.(`[webex:${account.accountId}] stopping`);
  targets.delete(botWebhookPath);
  targets.delete(oauthWebhookPath);

  await deregisterWebhooks(cfg, { log }).catch((err) =>
    log?.warn?.(
      `[webex:${account.accountId}] webhook deregister failed: ${err?.message}`
    )
  );
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
        context.MessageThreadId != null
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
      // Diagnostic only — direct ground truth for whether the message tool
      // actually threads the send, since this is the one place upstream
      // params unambiguously have to land for it to matter at all. Remove
      // once threading is confirmed working live.
      console.log('[collab-agent:channel-send] sendText replyToId', {
        to,
        replyToId: replyToId ?? null,
      });

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

      const msg = await sendWebexMessage({
        token: resolvedAccount.config.token,
        to,
        // Sent as `markdown`, not `text` — Webex only renders formatting
        // (bold, links, etc.) through the markdown field; text is shown
        // literally, including any markdown syntax the model wrote (e.g. a
        // reply ending up as literal "**Postgres**" instead of bold). The
        // shared message tool has no separate markdown/format parameter for
        // the model to target (confirmed against the deployed gateway
        // bundle — MessageToolSchema has no such field), so this can't be
        // fixed via prompting; it's the channel adapter's job. Webex derives
        // a plaintext `text` fallback automatically from `markdown` when
        // `text` is omitted, so nothing is lost for non-rendering clients.
        markdown: text,
        parentId: replyToId,
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
      // Diagnostic only — see sendText's identical note above.
      console.log('[collab-agent:channel-send] sendMedia replyToId', {
        to,
        replyToId: replyToId ?? null,
      });

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

      const msg = await sendWebexMessage({
        token: resolvedAccount.config.token,
        to,
        // See sendText's identical note above — markdown, not text, is what
        // Webex actually renders.
        markdown: text,
        files: mediaUrl ? [mediaUrl] : undefined,
        parentId: replyToId,
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
    /*
    start account
    → set/refresh OAuth access token
    → fetch bot identity with /people/me
    → start periodic token refresh
    → ensureWebhooks(cfg)
    → register local target in targets map
    → run pending batch recovery
    → stay alive until stopped
    */
    startAccount: async (ctx) => {
      const { account, log, setStatus } = ctx;
      const cfg = account.config;

      setStatus?.({ accountId: account.accountId, baseUrl: WEBEX_API });
      log?.info?.(`[webex:${account.accountId}] starting`);

      // Initialise OAuth access token for broad Webex API access.
      if (cfg.refreshToken && cfg.clientId && cfg.clientSecret) {
        try {
          const freshToken = await refreshAccessToken(cfg);
          setAccessToken(freshToken);
          log?.info?.(
            `[webex:${account.accountId}] access token refreshed on start`
          );
        } catch (err) {
          setAccessToken(cfg.accessToken ?? null);
          log?.warn?.(
            `[webex:${account.accountId}] startup token refresh failed: ${err?.message}`
          );
        }
      } else {
        setAccessToken(cfg.accessToken ?? null);
      }

      // Resolve bot identity so we can filter self-messages and detect mentions
      const botInfo = await webexFetch(cfg.token, '/people/me');
      const botId = botInfo.id;
      log?.info?.(`[webex:${account.accountId}] bot id=${botId}`);

      // Refresh access token every 12 days (tokens last ~14 days); Webex auto-renews the refresh token.
      let refreshInterval = null;
      if (cfg.refreshToken && cfg.clientId && cfg.clientSecret) {
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

      // Register (or refresh) the Webex webhooks for this account
      await ensureWebhooks({ cfg, account, log });
      log?.info?.(`[webex:${account.accountId}] Webex webhooks registered`);

      // Register the HTTP dispatch targets for incoming POSTs
      const botWebhookPath = normPath(
        `/webhooks/webex/bot/${account.accountId}`
      );
      targets.set(botWebhookPath, {
        account,
        handle: (payload) =>
          handleInboundWebexWebhook(payload, {
            identity: 'bot',
            tokenKind: 'bot',
            botId,
            cfg,
            account,
            log,
          }),
      });
      log?.info?.(`[webex:${account.accountId}] ready at ${botWebhookPath}`);

      const oauthWebhookPath = normPath(
        `/webhooks/webex/oauth/${account.accountId}`
      );
      targets.set(oauthWebhookPath, {
        account,
        handle: (payload) =>
          handleInboundWebexWebhook(payload, {
            identity: 'oauth',
            tokenKind: 'oauth',
            botId,
            cfg,
            account,
            log,
          }),
      });
      log?.info?.(`[webex:${account.accountId}] ready at ${oauthWebhookPath}`);

      // Batch restart-recovery scanning (batch/schedule.js) was built around
      // the debounce-timer trigger model: a persisted `scheduledRunAfter`
      // deadline that's always due shortly after the last message, recovered
      // if the in-memory timer was lost to a restart. Deterministic dispatch
      // (v3 §5, phase 3) has no such deadline — a thread can legitimately sit
      // pending indefinitely until it's mentioned or judged ready — so running
      // this scan now would force-stage threads dispatch intentionally held
      // back. Not wired until it's rebuilt against Task Flow persistence
      // (phase 5+).

      // The channel must stay alive until the gateway stops it.
      // On shutdown the finally block deregisters the target and Webex webhook.
      try {
        await new Promise(() => {}); // never resolves
      } finally {
        await cleanupAccountResources({
          account,
          cfg,
          log,
          refreshInterval,
          botWebhookPath,
          oauthWebhookPath,
        });
      }
    },
  },
};

module.exports = { webexPlugin, DEFAULT_ACCOUNT, cleanupAccountResources };

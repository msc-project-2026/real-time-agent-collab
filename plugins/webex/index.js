'use strict';

const { createHmac, timingSafeEqual } = require('node:crypto');

const WEBEX_API = 'https://webexapis.com/v1';
const DEFAULT_ACCOUNT = 'default';
const MAX_BODY_BYTES = 1024 * 1024;

// Active webhook targets registered by startAccount, keyed by normalized path.
// Each entry: { account, handle(payload) → Promise }
const targets = new Map();

// ── utilities ─────────────────────────────────────────────────────────────

function normPath(p) {
  const s = String(p ?? '').trim();
  if (!s) return '/';
  const r = s.startsWith('/') ? s : `/${s}`;
  return r.length > 1 && r.endsWith('/') ? r.slice(0, -1) : r;
}

async function webexFetch(token, path, opts = {}) {
  const { method = 'GET', body } = opts;
  const res = await fetch(`${WEBEX_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  // 404 on DELETE is harmless
  if (method === 'DELETE' && res.status === 404) return null;
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Webex ${method} ${path} → ${res.status}: ${text}`);
  }
  return method === 'DELETE' ? null : res.json();
}

// Verify HMAC-SHA1 over the raw request body bytes.
// Returns true when no secret is configured (skip verification).
function verifyHmac(secret, rawBody, signature) {
  if (!secret) return true;
  if (!signature) return false;
  const mac = createHmac('sha1', secret);
  mac.update(rawBody);
  const expected = Buffer.from(mac.digest('hex'));
  const given = Buffer.from(String(signature));
  if (expected.length !== given.length) return false;
  try {
    return timingSafeEqual(expected, given);
  } catch {
    return false;
  }
}

function isDmAllowed(cfg, personId, personEmail) {
  switch (cfg.dmPolicy) {
    case 'allow':
      return true;
    case 'deny':
      return false;
    case 'allowlisted': {
      const list = cfg.allowFrom ?? [];
      return list.includes(personId) || list.includes(personEmail);
    }
    default:
      return false;
  }
}

// Build a Webex Messages API POST body, inferring roomId vs toPersonId vs email.
function buildMsgBody(to, content, parentId) {
  const body = {};
  if (to.includes('@')) {
    body.toPersonEmail = to;
  } else {
    try {
      const dec = Buffer.from(to, 'base64').toString('utf-8');
      body[dec.includes('/PEOPLE/') ? 'toPersonId' : 'roomId'] = to;
    } catch {
      body.roomId = to;
    }
  }
  if (content.text) body.text = content.text;
  if (content.markdown) body.markdown = content.markdown;
  if (content.files?.length) body.files = [content.files[0]];
  if (parentId) body.parentId = parentId;
  return body;
}

// ── OAuth token refresh ───────────────────────────────────────────────────

async function refreshAccessToken(cfg) {
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    refresh_token: cfg.refreshToken,
  });
  const res = await fetch(`${WEBEX_API}/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Webex token refresh → ${res.status}: ${text}`);
  }
  const data = await res.json();
  return data.access_token;
}

// ── webhook registration ──────────────────────────────────────────────────

// Deregisters any existing webhooks pointing at cfg.webhookUrl then creates a
// fresh one.  Idempotent — safe to call on every startAccount.
async function ensureWebhook(cfg) {
  const token = currentAccessToken ?? cfg.token;
  const data = await webexFetch(token, '/webhooks');
  await Promise.all(
    (data?.items ?? [])
      .filter((w) => w.targetUrl === cfg.webhookUrl)
      .map((w) => webexFetch(token, `/webhooks/${w.id}`, { method: 'DELETE' }))
  );
  await webexFetch(token, '/webhooks', {
    method: 'POST',
    body: {
      name: 'OpenClaw Message Handler',
      targetUrl: cfg.webhookUrl,
      resource: 'messages',
      event: 'created',
      ...(cfg.webhookSecret ? { secret: cfg.webhookSecret } : {}),
    },
  });
}

async function deregisterWebhooks(cfg) {
  const token = currentAccessToken ?? cfg.token;
  const data = await webexFetch(token, '/webhooks');
  await Promise.all(
    (data?.items ?? [])
      .filter((w) => w.targetUrl === cfg.webhookUrl)
      .map((w) => webexFetch(token, `/webhooks/${w.id}`, { method: 'DELETE' }))
  );
}

// ── inbound message handling ──────────────────────────────────────────────

// Called asynchronously after the webhook POST is acknowledged.  Filters,
// fetches full message details, then delivers to the OpenClaw agent pipeline.
async function handleInbound(payload, { botId, cfg, account, log }) {
  if (payload.resource !== 'messages' || payload.event !== 'created') return;

  // Ignore messages sent by the bot itself
  if (payload.data?.personId === botId) return;

  // Apply DM policy for direct messages
  if (payload.data?.roomType === 'direct') {
    if (!isDmAllowed(cfg, payload.data.personId, payload.data.personEmail))
      return;
  }

  // Webhooks only carry IDs — fetch full message to get text + mentions
  const msg = await webexFetch(
    currentAccessToken ?? cfg.token,
    `/messages/${payload.data.id}`
  );

  // *** Addition: only process messages from spaces where the bot is a member
  let membership;
  try {
    membership = await webexFetch(
      cfg.token,
      `/memberships?roomId=${msg.roomId}&personId=${botId}`
    );
  } catch {
    return; // bot not in this space or no access — skip silently
  }
  if (!membership?.items?.length) return;

  const isMentioned =
    Array.isArray(msg.mentionedPeople) && msg.mentionedPeople.includes(botId);

  // Context payload consumed by the OpenClaw agent pipeline.
  // IsMentioned is delivered as a signal for the agent, not used to gate here.
  const ctxPayload = {
    Body: msg.text ?? '',
    RawBody: msg.text ?? '',
    CommandBody: msg.text ?? '',
    From: `webex:${msg.personId}`,
    To: `webex:${msg.roomId}`,
    SessionKey: `agent:main:webex:${msg.roomId}`,
    AccountId: account.accountId,
    ChatType: msg.roomType === 'direct' ? 'direct' : 'group',
    SenderName: msg.personEmail ?? msg.personId,
    SenderId: msg.personId,
    Provider: 'webex',
    Surface: 'webex',
    MessageSid: msg.id,
    Timestamp: msg.created,
    OriginatingChannel: 'webex',
    OriginatingTo: `webex:${msg.roomId}`,
    MessageThreadId: msg.parentId,
    IsMentioned: isMentioned,
  };

  const dispatch =
    pluginRuntime?.channel?.reply?.dispatchReplyWithBufferedBlockDispatcher;
  if (!dispatch) {
    log?.warn?.(
      `[webex:${account.accountId}] agent pipeline dispatch unavailable`
    );
    return;
  }

  const loadedCfg = pluginRuntime.config?.current?.() ?? {};
  await dispatch({
    ctx: ctxPayload,
    cfg: loadedCfg,
    dispatcherOptions: {
      deliver: async (out) => {
        if (!out.text) return;
        await webexFetch(cfg.token, '/messages', {
          method: 'POST',
          body: buildMsgBody(msg.roomId, { text: out.text }, msg.parentId),
        });
      },
      onError: (err) => {
        log?.error?.(
          `[webex:${account.accountId}] reply dispatch error: ${err?.message ?? err}`
        );
      },
    },
    replyOptions: {},
  });
}

// ── HTTP route handler ────────────────────────────────────────────────────

// Registered at /webhooks/webex/ (prefix match, auth: plugin).
// Dispatches to the right account target based on the full path.
async function webhookRouter(req, res) {
  console.log(`[webex] webhookRouter called: ${req.method} ${req.url}`);
  const path = normPath(new URL(req.url ?? '/', 'http://x').pathname);
  const target = targets.get(path);
  if (!target) return false; // not our path

  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.setHeader('Allow', 'POST');
    res.end('Method Not Allowed');
    return true;
  }

  // Read the raw body bytes (needed for HMAC verification)
  let rawBody;
  try {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        break;
      }
      chunks.push(chunk);
    }
    if (tooLarge) {
      res.statusCode = 413;
      res.end('Payload Too Large');
      return true;
    }
    rawBody = Buffer.concat(chunks);
  } catch {
    if (!res.headersSent) {
      res.statusCode = 400;
      res.end('Bad Request');
    }
    return true;
  }

  // Verify HMAC-SHA1 over the raw bytes (not re-stringified JSON)
  const sig = req.headers['x-spark-signature'];
  if (!verifyHmac(target.account.config.webhookSecret, rawBody, sig)) {
    res.statusCode = 401;
    res.end('Unauthorized');
    return true;
  }

  let payload;
  try {
    payload = JSON.parse(rawBody.toString('utf-8'));
  } catch {
    res.statusCode = 400;
    res.end('Bad Request');
    return true;
  }

  // ACK immediately — Webex requires a fast 200 response
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json');
  res.end('{"ok":true}');

  target.handle(payload).catch((err) => {
    console.error(
      `[webex:${target.account.accountId}] inbound error: ${err?.message ?? err}`
    );
  });

  return true;
}

// ── config resolution ─────────────────────────────────────────────────────

function listAccountIds(cfg) {
  const section = cfg?.channels?.webex;
  if (!section?.token) return [];
  const ids = [DEFAULT_ACCOUNT];
  if (section.accounts) {
    for (const id of Object.keys(section.accounts)) {
      if (id !== DEFAULT_ACCOUNT) ids.push(id);
    }
  }
  return ids;
}

function resolveAccount(cfg, accountId = DEFAULT_ACCOUNT) {
  const section = cfg?.channels?.webex ?? {};
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

  if (!resolved)
    return { accountId, enabled: false, configured: false, config: {} };

  return {
    accountId,
    enabled: section.enabled !== false,
    configured: Boolean(resolved.token && resolved.webhookUrl),
    config: resolved,
  };
}

// ── channel plugin object ─────────────────────────────────────────────────

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
        const t = String(raw ?? '').trim();
        return t.startsWith('Y2lzY29zcGFyazovL3') || t.includes('@');
      },
      hint: '<roomId|personId|email>',
    },
  },

  outbound: {
    deliveryMode: 'direct',
    textChunkLimit: 7000, // Webex max is 7439 bytes

    sendText: async ({ to, text, account, replyToId }) => {
      const msg = await webexFetch(account.config.token, '/messages', {
        method: 'POST',
        body: buildMsgBody(to, { text }, replyToId),
      });
      return { channel: 'webex', messageId: msg.id, roomId: msg.roomId };
    },

    sendMedia: async ({ to, text, mediaUrl, account, replyToId }) => {
      const msg = await webexFetch(account.config.token, '/messages', {
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
      const { account, runtime, log, setStatus } = ctx;
      const cfg = account.config;

      setStatus?.({ accountId: account.accountId, baseUrl: WEBEX_API });
      log?.info?.(`[webex:${account.accountId}] starting`);

      // Initialise OAuth access token (used for all API calls except sending replies)
      currentAccessToken = cfg.accessToken ?? null;

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
            currentAccessToken = await refreshAccessToken(cfg);
            log?.info?.(`[webex:${account.accountId}] access token refreshed`);
          } catch (err) {
            log?.warn?.(
              `[webex:${account.accountId}] token refresh failed: ${err?.message}`
            );
          }
        }, TWELVE_DAYS_MS);
      }

      // Register (or refresh) the Webex webhook for this account
      await ensureWebhook(cfg);
      log?.info?.(`[webex:${account.accountId}] Webex webhook registered`);

      // Register the HTTP dispatch target for incoming POSTs
      const webhookPath = normPath(`/webhooks/webex/${account.accountId}`);
      targets.set(webhookPath, {
        account,
        handle: (payload) =>
          handleInbound(payload, { botId, cfg, account, log }),
      });
      log?.info?.(`[webex:${account.accountId}] ready at ${webhookPath}`);

      // The channel must stay alive until the gateway stops it.
      // On shutdown the finally block deregisters the target and Webex webhook.
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
      }
    },
  },
};

// ── plugin registration entry point ──────────────────────────────────────

// module-level
let pluginRuntime = null;
// Current OAuth access token — updated by the 12-day refresh interval in startAccount.
// Falls back to cfg.token (bot token) when null.
let currentAccessToken = null;

function register(api) {
  pluginRuntime = api.runtime;

  api.registerChannel({ plugin: webexPlugin });
  api.registerHttpRoute({
    path: '/webhooks/webex/',
    auth: 'plugin',
    match: 'prefix',
    handler: webhookRouter,
  });
}

module.exports = register;
module.exports.default = register;
module.exports.id = 'webex';
module.exports.webexPlugin = webexPlugin;

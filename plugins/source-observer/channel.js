// OpenClaw channel wrapper for the source observer scheduler.
'use strict';

const { createObserver } = require('./observer');
const prefs = require('./prefs');
const { dispatchWithSessionRecovery } = require('../../lib/dispatch-retry.js');

const CHANNEL_ID = 'source-observer';
const DEFAULT_ACCOUNT = 'default';

let pluginRuntime = null;
function setRuntime(runtime) {
  pluginRuntime = runtime;
}

function listAccountIds(cfg) {
  return cfg?.channels?.[CHANNEL_ID]?.enabled === false ? [] : [DEFAULT_ACCOUNT];
}

function resolveAccount(cfg, accountId = DEFAULT_ACCOUNT) {
  const section = cfg?.channels?.[CHANNEL_ID] ?? {};
  return {
    accountId,
    enabled: section.enabled !== false,
    configured: true,
    config: {},
  };
}

const sourceObserverPlugin = {
  id: CHANNEL_ID,
  meta: {
    id: CHANNEL_ID,
    label: 'Source Observer',
    selectionLabel: 'Source Observer',
    docsPath: '/channels/source-observer',
    blurb: 'Periodically summarizes repository changes into collaboration context.',
    order: 90,
    aliases: ['source-observer'],
  },
  capabilities: { chatTypes: ['direct'], threads: false, media: false },
  reload: { configPrefixes: ['channels.source-observer'] },

  config: {
    listAccountIds,
    resolveAccount,
    defaultAccountId: () => DEFAULT_ACCOUNT,
    isConfigured: (account) => account.configured,
    describeAccount: (account) => ({
      accountId: account.accountId,
      enabled: account.enabled,
      configured: account.configured,
    }),
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
                channel: CHANNEL_ID,
                accountId: a.accountId,
                kind: 'runtime',
                message: `Channel error: ${err}`,
              },
            ]
          : [];
      }),
    buildAccountSnapshot: ({ account, runtime }) => ({
      accountId: account.accountId,
      enabled: account.enabled,
      configured: account.configured,
      running: runtime?.running ?? false,
      lastStartAt: runtime?.lastStartAt ?? null,
      lastStopAt: runtime?.lastStopAt ?? null,
      lastError: runtime?.lastError ?? null,
    }),
    probeAccount: async () => ({ ok: true, elapsedMs: 0 }),
  },

  gateway: {
    startAccount: async ({ account, log, setStatus }) => {
      setStatus?.({ accountId: account.accountId });
      log?.info?.(`[${CHANNEL_ID}:${account.accountId}] starting`);

      const observer = createObserver({
        log,
        dispatchAgentPrompt: (prompt) => dispatchAgentPrompt(prompt, log),
        notifyRoom: async (spaceId, text, { files = [], isBreaking = false } = {}) => {
          const token = process.env.WEBEX_BOT_TOKEN;
          if (!token) return;
          // Mode + file watch pattern filter (respects room preset)
          if (!prefs.shouldNotify(spaceId, files, { isBreaking })) return;
          await fetch('https://webexapis.com/v1/messages', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({ roomId: spaceId, markdown: text }),
          });
        },
      });

      let stopped = false;
      let running = false;

      const runTick = async () => {
        if (stopped || running) return;
        running = true;
        try {
          await observer.tick();
        } catch (err) {
          log?.error?.(
            `[${CHANNEL_ID}:${account.accountId}] observer tick failed: ${
              err?.message ?? err
            }`
          );
        } finally {
          running = false;
        }
      };

      const interval = setInterval(runTick, observer.intervalMs);
      runTick();

      try {
        await new Promise(() => {});
      } finally {
        stopped = true;
        clearInterval(interval);
        log?.info?.(`[${CHANNEL_ID}:${account.accountId}] stopping`);
      }
    },
  },
};

async function dispatchAgentPrompt(prompt, log) {
  const dispatch =
    pluginRuntime?.channel?.reply?.dispatchReplyWithBufferedBlockDispatcher;
  if (!dispatch) {
    throw new Error('OpenClaw agent pipeline dispatch unavailable');
  }

  const replies = [];
  const loadedCfg = pluginRuntime.config?.current?.() ?? {};
  const now = new Date().toISOString();
  const canonicalSessionKey = 'agent:observer:source-observer:default';
  const messageSid = `source-observer:${Date.now()}`;

  // The suffix variant only runs for the recovery fallback in
  // dispatchWithSessionRecovery, when the canonical key's initialization
  // conflict never clears (see lib/dispatch-retry.js).
  const buildDispatchArgs = (sessionKeySuffix) => ({
    ctx: {
      Body: prompt,
      RawBody: prompt,
      CommandBody: prompt,
      From: 'source-observer',
      To: 'source-observer',
      SessionKey: sessionKeySuffix
        ? `${canonicalSessionKey}:${sessionKeySuffix}`
        : canonicalSessionKey,
      AccountId: DEFAULT_ACCOUNT,
      ChatType: 'direct',
      SenderName: 'Source Observer',
      SenderId: 'source-observer',
      Provider: CHANNEL_ID,
      Surface: CHANNEL_ID,
      MessageSid: messageSid,
      Timestamp: now,
      OriginatingChannel: CHANNEL_ID,
      OriginatingTo: CHANNEL_ID,
      IsMentioned: true,
    },
    cfg: loadedCfg,
    dispatcherOptions: {
      deliver: async (out) => {
        const text = out?.text || out?.markdown;
        if (text) replies.push(text);
      },
      onError: (err) => {
        log?.error?.(`[${CHANNEL_ID}] agent dispatch error: ${err?.message ?? err}`);
      },
    },
    replyOptions: {},
  });

  await dispatchWithSessionRecovery(dispatch, buildDispatchArgs, {
    onRecovery: (recoverySuffix, err) =>
      log?.warn?.(
        `[${CHANNEL_ID}] observer session conflict persisted after retries; ` +
          `dispatching once with recovery session key ${recoverySuffix}: ${err?.message ?? err}`
      ),
  });

  return replies.join('\n');
}

module.exports = { sourceObserverPlugin, setRuntime };

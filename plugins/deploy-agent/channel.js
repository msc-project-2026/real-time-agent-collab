// Two lightweight channels that exist purely so OpenClaw bindings can route a
// dispatched prompt to the right agent/model tier:
//
//   deploy       -> deployer agent        (cheap model, drives the CLI tools)
//   deploy-debug -> deploy-debugger agent (expensive model, only on failure)
//
// Unlike the source-observer channel there is no scheduler here; the channels
// are dispatch targets, driven on demand by the handoff tools. The dispatch
// mechanism itself mirrors source-observer exactly.
'use strict';

const DEPLOY_CHANNEL = 'deploy';
const DEBUG_CHANNEL = 'deploy-debug';
const DEFAULT_ACCOUNT = 'default';

let pluginRuntime = null;
function setRuntime(runtime) {
  pluginRuntime = runtime;
}

function makeChannel(channelId, label, blurb) {
  return {
    id: channelId,
    meta: { id: channelId, label, selectionLabel: label, blurb, order: 95, aliases: [channelId] },
    capabilities: { chatTypes: ['direct'], threads: false, media: false },
    reload: { configPrefixes: [`channels.${channelId}`] },
    config: {
      listAccountIds: (cfg) =>
        cfg?.channels?.[channelId]?.enabled === false ? [] : [DEFAULT_ACCOUNT],
      resolveAccount: (cfg, accountId = DEFAULT_ACCOUNT) => ({
        accountId,
        enabled: cfg?.channels?.[channelId]?.enabled !== false,
        configured: true,
        config: {},
      }),
      defaultAccountId: () => DEFAULT_ACCOUNT,
      isConfigured: (account) => account.configured,
      describeAccount: (account) => ({
        accountId: account.accountId,
        enabled: account.enabled,
        configured: account.configured,
      }),
    },
    status: {
      defaultRuntime: { accountId: DEFAULT_ACCOUNT, running: false, lastError: null },
      collectStatusIssues: () => [],
      buildAccountSnapshot: ({ account, runtime }) => ({
        accountId: account.accountId,
        enabled: account.enabled,
        configured: account.configured,
        running: runtime?.running ?? false,
        lastError: runtime?.lastError ?? null,
      }),
      probeAccount: async () => ({ ok: true, elapsedMs: 0 }),
    },
    gateway: {
      // The channel just needs to be "up" so bindings resolve and dispatches
      // route here. It does no background work; it idles until shutdown.
      startAccount: async ({ account, log, setStatus }) => {
        setStatus?.({ accountId: account.accountId });
        log?.info?.(`[${channelId}:${account.accountId}] ready (dispatch target)`);
        try {
          await new Promise(() => {});
        } finally {
          log?.info?.(`[${channelId}:${account.accountId}] stopping`);
        }
      },
    },
  };
}

const deployChannelPlugin = makeChannel(
  DEPLOY_CHANNEL,
  'Deployment Agent',
  'On-demand deployment orchestration (cheap tier).'
);
const debugChannelPlugin = makeChannel(
  DEBUG_CHANNEL,
  'Deployment Debugger',
  'Deployment failure diagnosis and repair (expensive tier).'
);

// dispatch sends a prompt into the OpenClaw agent pipeline on a given channel,
// letting the configured binding pick the agent + model. Returns the agent's
// combined reply text. This is the same primitive source-observer uses.
async function dispatch(channelId, agentLabel, prompt, log) {
  const dispatchFn =
    pluginRuntime?.channel?.reply?.dispatchReplyWithBufferedBlockDispatcher;
  if (!dispatchFn) {
    throw new Error('OpenClaw agent pipeline dispatch unavailable');
  }

  const replies = [];
  const loadedCfg = pluginRuntime.config?.current?.() ?? {};
  const now = new Date().toISOString();

  await dispatchFn({
    ctx: {
      Body: prompt,
      RawBody: prompt,
      CommandBody: prompt,
      From: channelId,
      To: channelId,
      SessionKey: `agent:${agentLabel}:${channelId}:default`,
      AccountId: DEFAULT_ACCOUNT,
      ChatType: 'direct',
      SenderName: agentLabel,
      SenderId: channelId,
      Provider: channelId,
      Surface: channelId,
      MessageSid: `${channelId}:${Date.now()}`,
      Timestamp: now,
      OriginatingChannel: channelId,
      OriginatingTo: channelId,
      IsMentioned: true,
    },
    cfg: loadedCfg,
    dispatcherOptions: {
      deliver: async (out) => {
        const text = out?.text || out?.markdown;
        if (text) replies.push(text);
      },
      onError: (err) => {
        log?.error?.(`[${channelId}] agent dispatch error: ${err?.message ?? err}`);
      },
    },
    replyOptions: {},
  });

  return replies.join('\n');
}

module.exports = {
  setRuntime,
  deployChannelPlugin,
  debugChannelPlugin,
  dispatch,
  DEPLOY_CHANNEL,
  DEBUG_CHANNEL,
};

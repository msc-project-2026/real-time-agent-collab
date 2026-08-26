// ********* CONFIG/HANDLE-REQUEST.JS *********
'use strict';

const { readActiveConfig } = require('./store');
const { sendConfigCard } = require('./card');

// Handler
async function handleConfigRequest({ spaceId, threadKey, message, account, botId, log, sendFn }) {
  if (!spaceId) throw new Error('spaceId is required');
  if (!account) throw new Error('account is required');

  const activeConfig = await readActiveConfig({ spaceId });

  log?.info?.(
    `[collab-agent:config-request] handling config request ${JSON.stringify({
      spaceId,
      hasActiveConfig: Boolean(activeConfig),
    })}`
  );

  await sendConfigCard({
    spaceId,
    threadKey,
    message,
    account,
    botId,
    log,
    config: activeConfig?.config ?? {},
    sendFn,
  });
}

module.exports = {
  handleConfigRequest,
};

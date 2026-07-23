// ********* CONFIG/HANDLE-REQUEST.JS *********
'use strict';

const { readActiveConfig } = require('./store');
const { sendConfigCard } = require('./card');

// Handler
async function handleConfigRequest({ spaceId, account, log }) {
  if (!spaceId) throw new Error('spaceId is required');
  if (!account) throw new Error('account is required');

  const activeConfig = await readActiveConfig({ spaceId });

  log?.info?.(`[webex:${account.accountId}] handling config request`, {
    spaceId,
    hasActiveConfig: Boolean(activeConfig),
  });

  await sendConfigCard({
    spaceId,
    account,
    log,
    config: activeConfig?.config ?? {},
  });
}

module.exports = {
  handleConfigRequest,
};

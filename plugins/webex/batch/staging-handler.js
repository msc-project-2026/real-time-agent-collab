// ********* BATCH/STAGING-HANDLER.JS *********
'use strict';

const { stagePendingBatch } = require('./stage');
const { handleProcessStagedBatchRequest } = require('./processing-handler');

async function handleStagePendingBatchRequest({ spaceId, account, log }) {
  if (!spaceId) throw new Error('spaceId is required');
  if (!account) throw new Error('account is required');

  const result = await stagePendingBatch({ spaceId });

  log?.info?.(`[webex:${account.accountId}] pending batch staging result`, {
    spaceId,
    staged: result.staged,
    batchId: result.batchId,
    messageCount: result.messageCount,
  });

  if (!result.staged || result.messageCount <= 0) {
    return result;
  }

  await handleProcessStagedBatchRequest({
    spaceId,
    batchId: result.batchId,
    account,
    log,
  });

  return result;
}

module.exports = {
  handleStagePendingBatchRequest,
};

// ********* BATCH/PROCESSING-HANDLER.JS *********
'use strict';

const { buildProcessingInstruction } = require('../instructions/processing');
const { dispatchToAgentForSpace } = require('../dispatch');
const { getPluginRuntime } = require('../runtime');
const { makeProcessingResultHandler } = require('../processing/result-handler');
const { loadProcessingBatch } = require('./load');

// Process staged batch
async function handleProcessStagedBatchRequest({
  spaceId,
  batchId,
  account,
  log,
}) {
  if (!spaceId) throw new Error('spaceId is required');
  if (!batchId) throw new Error('batchId is required');
  if (!account) throw new Error('account is requried');

  const processingBatch = await loadProcessingBatch({
    spaceId,
    batchId,
  });

  const processingInstruction = buildProcessingInstruction({
    batch: processingBatch,
  });

  function buildProcessStagedBatchCtxPayload(sessionKeySuffix) {
    return {
      Body: '',
      RawBody: '',
      CommandBody: processingInstruction,
      From: 'webex:internal-batch-processor',
      To: `webex:${spaceId}`,
      SessionKey: sessionKeySuffix
        ? `agent:main:webex:${spaceId}:batch:${batchId}:${sessionKeySuffix}`
        : `agent:main:webex:${spaceId}:batch:${batchId}`,
      WebexRoomId: spaceId,
      AccountId: account.accountId,
      ChatType: 'group',
      SenderName: 'internal-batch-processor',
      SenderId: 'internal-batch-processor',
      Provider: 'webex',
      Surface: 'webex',
      MessageSid: `process_staged_batch:${spaceId}:${batchId}:${Date.now()}`,
      Timestamp: context.createdAt,
      OriginatingChannel: 'webex',
      OriginatingTo: `webex:${spaceId}`,
      MessageThreadId: null,
    };
  }

  await dispatchToAgentForSpace({
    pluginRuntime: getPluginRuntime(),
    spaceId,
    account,
    log,
    buildCtxPayload: buildProcessStagedBatchCtxPayload,
    onAgentOutput: makeProcessingResultHandler({
      processingBatch,
      account,
      log,
    }),
  });
}

module.exports = {
  handleProcessStagedBatchRequest,
};

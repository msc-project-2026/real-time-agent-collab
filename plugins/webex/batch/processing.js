// ********* BATCH/PROCESSING.JS *********
'use strict';

const { buildProcessingInstruction } = require('../instructions/processing');
const { dispatchToAgentForSpace } = require('../dispatch');
const { getPluginRuntime } = require('../runtime');

// Process staged batch
async function handleProcessStagedBatchRequest({
  spaceId,
  batchId,
  account,
  log,
}) {
  if (!spaceId) throw new Error('spaceId is required');
  if (!batchId) throw new Error('batchId is required');

  const processingInstruction = buildProcessingInstruction();

  function buildProcessStagedBatchCtxPayload(sessionKeySuffix) {
    const context = {
      eventType: 'process_staged_batch',
      internal: true,
      spaceId,
      batchId,
      createdAt: new Date().toISOString(),
    };

    return {
      Body: '',
      RawBody: '',
      CommandBody: [
        processingInstruction,
        '',
        'Internal collaboration event:',
        '',
        '```json',
        JSON.stringify(context, null, 2),
        '```',
      ].join('\n'),

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
  });
}

module.exports = {
  handleProcessStagedBatchRequest,
};

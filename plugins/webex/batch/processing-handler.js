// ********* BATCH/PROCESSING-HANDLER.JS *********
'use strict';

const { dispatchToAgent } = require('../dispatch');
const { getPluginRuntime } = require('../runtime');

const { loadProcessingBatch } = require('./load');
const { getConversations } = require('../context/conversations-store.js');
const {
  buildConversationProcessingInstruction,
} = require('../processing/conversations/instruction.js');
const {
  makeConversationProcessingResultHandler,
} = require('../processing/conversations/result-handler.js');

// Process staged batch
async function handleProcessStagedBatchRequest({
  spaceId,
  batchId,
  account,
  log,
}) {
  if (!spaceId) throw new Error('spaceId is required');
  if (!batchId) throw new Error('batchId is required');
  if (!account) throw new Error('account is required');

  const processingBatch = await loadProcessingBatch({
    spaceId,
    batchId,
  });

  const existingConversations = await getConversations({
    spaceId,
    statuses: ['active', 'dormant'],
  });

  const conversationProcessingInstruction =
    buildConversationProcessingInstruction({
      batch: processingBatch,
      conversations: existingConversations,
    });

  const baseSessionKey = `agent:main:webex:${spaceId}:conv-processing`;

  const now = new Date().toISOString();

  function buildProcessStagedBatchCtxPayload(sessionKeySuffix) {
    return {
      Body: '',
      RawBody: '',
      CommandBody: conversationProcessingInstruction,
      From: 'webex:internal-batch-processor',
      To: `webex:${spaceId}`,
      SessionKey: sessionKeySuffix
        ? `${baseSessionKey}:${sessionKeySuffix}`
        : baseSessionKey,
      WebexRoomId: spaceId,
      AccountId: account.accountId,
      ChatType: 'group',
      SenderName: 'internal-batch-processor',
      SenderId: 'internal-batch-processor',
      Provider: 'webex',
      Surface: 'webex',
      MessageSid: `process_staged_batch:${spaceId}:${batchId}:${Date.now()}`,
      Timestamp: now,
      OriginatingChannel: 'webex',
      OriginatingTo: `webex:${spaceId}`,
      MessageThreadId: null,
    };
  }

  await dispatchToAgent({
    pluginRuntime: getPluginRuntime(),
    queueKey: `${spaceId}:conv-processing`,
    account,
    log,
    buildCtxPayload: buildProcessStagedBatchCtxPayload,
    onAgentOutput: makeConversationProcessingResultHandler({
      processingBatch,
      existingConversations,
      account,
      log,
    }),
  });
}

module.exports = {
  handleProcessStagedBatchRequest,
};

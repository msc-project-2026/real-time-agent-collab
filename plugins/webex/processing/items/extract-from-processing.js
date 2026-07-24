// ********* PROCESSING/ITEMS/EXTRACT-FROM-PROCESSING.JS *********
'use strict';

const { dispatchToAgentForSpace } = require('../../dispatch');
const { getPluginRuntime } = require('../../runtime');

const { readConversationsState } = require('../../context/conversations-store');
const { getCandidateItems } = require('../../context/items-store');

const { asArray } = require('../../utils/normalise');
const { buildItemExtractionInstruction } = require('./instruction');
const { makeItemExtractionResultHandler } = require('./result-handler');

function getTouchedConversations({
  conversationsState,
  touchedConversationIds,
}) {
  const touchedIds = new Set(asArray(touchedConversationIds));

  return asArray(conversationsState.conversations).filter((conversation) =>
    touchedIds.has(conversation.id)
  );
}

async function extractItemsFromProcessingResult({
  processingBatch,
  processingResult,
  touchedConversationIds,
  account,
  log,
}) {
  if (!processingBatch) throw new Error('processingBatch is required');
  if (!processingBatch.spaceId) {
    throw new Error('processingBatch.spaceId is required');
  }
  if (!processingBatch.batchId) {
    throw new Error('processingBatch.batchId is required');
  }
  if (!processingResult) throw new Error('processingResult is required');
  if (!account) throw new Error('account is required');

  const spaceId = processingBatch.spaceId;
  const batchId = processingBatch.batchId;

  if (asArray(touchedConversationIds).length === 0) {
    log?.info?.(
      `[webex:${account.accountId}] skipped item extraction ${JSON.stringify({
        spaceId,
        batchId,
        reason: 'no touched conversations',
      })}`
    );

    return {
      ok: true,
      skipped: true,
      dispatched: false,
      reason: 'no touched conversations',
      touchedConversationIds: [],
    };
  }

  const conversationsState = await readConversationsState({ spaceId });

  const touchedConversations = getTouchedConversations({
    conversationsState,
    touchedConversationIds,
  });

  const candidateItems = await getCandidateItems({
    spaceId,
    conversationIds: touchedConversationIds,
    limit: 100,
  });

  log?.info?.(
    `[webex:${account.accountId}] prepared item extraction ${JSON.stringify({
      spaceId,
      batchId,
      touchedConversationIds,
      touchedConversationCount: touchedConversations.length,
      candidateItemCount: candidateItems.length,
    })}`
  );

  // Dispatch item extraction
  const itemExtractionInstruction = buildItemExtractionInstruction({
    processingBatch,
    touchedConversations,
    candidateItems,
  });

  function buildItemExtractionCtxPayload(sessionKeySuffix) {
    return {
      Body: '',
      RawBody: '',
      CommandBody: itemExtractionInstruction,
      From: 'webex:internal-item-extractor',
      To: `webex:${spaceId}`,
      SessionKey: sessionKeySuffix
        ? `agent:main:webex:${spaceId}:batch:${batchId}:items:${sessionKeySuffix}`
        : `agent:main:webex:${spaceId}:batch:${batchId}:items`,
      WebexRoomId: spaceId,
      AccountId: account.accountId,
      ChatType: 'group',
      SenderName: 'internal-item-extractor',
      SenderId: 'internal-item-extractor',
      Provider: 'webex',
      Surface: 'webex',
      MessageSid: `extract_items:${spaceId}:${batchId}:${Date.now()}`,
      Timestamp: new Date().toISOString(),
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
    buildCtxPayload: buildItemExtractionCtxPayload,
    onAgentOutput: makeItemExtractionResultHandler({
      processingBatch,
      account,
      log,
    }),
  });

  return {
    ok: true,
    skipped: false,
    dispatched: true,
    touchedConversationIds,
    touchedConversationCount: touchedConversations.length,
    candidateItemCount: candidateItems.length,
  };
}

module.exports = {
  extractItemsFromProcessingResult,
};

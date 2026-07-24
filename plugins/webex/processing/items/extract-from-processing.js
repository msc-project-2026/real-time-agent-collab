// ********* PROCESSING/CONVERSATIONS/EXTRACT-FROM-PROCESSING.JS *********
'use strict';

const { readConversationsState } = require('../../context/conversations-store');
const { getCandidateItems } = require('../../context/items-store');
const { asArray } = require('../../utils/normalise');

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

  return {
    ok: true,
    skipped: false,
    touchedConversationIds,
    touchedConversations,
    candidateItems,
  };
}

module.exports = {
  extractItemsFromProcessingResult,
};

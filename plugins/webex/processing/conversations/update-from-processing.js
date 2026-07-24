// ********* PROCESSING/CONVERSATIONS/UPDATE-FROM-PROCESSING.JS *********
'use strict';

const crypto = require('node:crypto');

const {
  readConversationsState,
  writeConversationsState,
} = require('../../context/conversations-store');
const { asArray, cleanString, unique } = require('../../utils/normalise');

// Helpers
function createConversationId() {
  return `conv_${crypto.randomUUID()}`;
}

// Apply result to state
function applyConversationResult({ state, result }) {
  const now = new Date().toISOString();

  const conversations = [...asArray(state.conversations)];
  const touchedConversationIds = [];

  for (const update of asArray(result.conversationUpdates)) {
    const index = conversations.findIndex(
      (conversation) => conversation.id === update.conversationId
    );

    if (index === -1) continue;

    const existing = conversations[index];

    conversations[index] = {
      ...existing,
      summary: cleanString(update.summary) || existing.summary,
      status: 'active',
      lastMessageIds: unique([
        ...asArray(existing.lastMessageIds),
        ...asArray(update.messageIds),
      ]).slice(-20),
      updatedAt: now,
    };

    touchedConversationIds.push(existing.id);
  }

  for (const conversation of asArray(result.newConversations)) {
    const id = createConversationId();

    conversations.push({
      id,
      topic: cleanString(conversation.topic),
      summary: cleanString(conversation.summary),
      status: 'active',
      lastMessageIds: unique(asArray(conversation.messageIds)).slice(-20),
      startedAt: now,
      updatedAt: now,
    });

    touchedConversationIds.push(id);
  }

  return {
    newState: {
      ...state,
      conversations,
      updatedAt: now,
    },
    touchedConversationIds: unique(touchedConversationIds),
  };
}

// Update
async function updateConversationsFromProcessingResult({
  processingBatch,
  processingResult,
  account,
  log,
}) {
  const spaceId = processingBatch.spaceId;
  const state = await readConversationsState({ spaceId });

  const { newState, touchedConversationIds } = applyConversationResult({
    state,
    result: processingResult,
  });

  await writeConversationsState({
    spaceId,
    state: newState,
  });

  log?.info?.(
    `[webex:${account.accountId}] updated conversation state from processing result ${JSON.stringify(
      {
        spaceId,
        batchId: processingBatch.batchId,
        conversationUpdates: processingResult.conversationUpdates.length,
        newConversations: processingResult.newConversations.length,
        untrackedMessageIds: processingResult.untrackedMessageIds.length,
        touchedConversationIds,
        touchedConversationCount: touchedConversationIds.length,
        responseNeeded: processingResult.responseDecision.needed,
      }
    )}`
  );

  return {
    touchedConversationIds,
  };
}

module.exports = {
  updateConversationsFromProcessingResult,
};

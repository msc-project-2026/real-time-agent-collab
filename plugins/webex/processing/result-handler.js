// ********* PROCESSING/RESULT-HANDLER.JS *********
'use strict';

const crypto = require('node:crypto');

const { parseJsonObjectFromText } = require('../utils/parse-json');
const {
  validateProcessingResult,
  asArray,
  cleanString,
} = require('./validate-result');
const {
  readConversationsState,
  writeConversationsState,
} = require('../context/conversations-store');

// Helpers
function createConversationId() {
  return `conv_${crypto.randomUUID()}`;
}

function unique(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

// *** Apply result to state
function applyConversationResult({ conversationsState, result }) {
  const now = new Date().toISOString();

  const conversations = [...asArray(conversationsState.conversations)];

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
  }

  for (const conversation of asArray(result.newConversations)) {
    conversations.push({
      id: createConversationId(),
      topic: cleanString(conversation.topic),
      summary: cleanString(conversation.summary),
      status: 'active',
      lastMessageIds: unique(asArray(conversation.messageIds)).slice(-20),
      startedAt: now,
      updatedAt: now,
    });
  }

  return {
    ...conversationsState,
    conversations,
    updatedAt: now,
  };
}

// *** Handle result
async function handleProcessingResult({
  result,
  processingBatch,
  account,
  log,
}) {
  if (!processingBatch) throw new Error('processingBatch is required');
  if (!processingBatch.spaceId)
    throw new Error('processingBatch.spaceId is required');
  if (!account) throw new Error('account is required');

  // Validate
  const errors = validateProcessingResult(result, {
    processingBatch,
  });

  if (errors.length > 0) {
    throw new Error(`invalid processing result: ${errors.join('; ')}`);
  }

  // Update
  const spaceId = processingBatch.spaceId;
  const currentConversationsState = await readConversationsState({ spaceId });

  const updatedConversationsState = applyConversationResult({
    conversationsState: currentConversationsState,
    result,
  });

  await writeConversationsState({
    spaceId,
    state: updatedConversationsState,
  });

  log?.info?.(
    `[webex:${account.accountId}] updated conversation state from processing result ${JSON.stringify(
      {
        spaceId,
        batchId: processingBatch.batchId,
        conversationUpdates: result.conversationUpdates.length,
        newConversations: result.newConversations.length,
        untrackedMessageIds: result.untrackedMessageIds.length,
        responseNeeded: result.responseDecision.needed,
      }
    )}`
  );

  return {
    ok: true,
    result,
    conversationsUpdated: result.conversationUpdates.length,
    conversationsCreated: result.newConversations.length,
  };
}

function makeProcessingResultHandler({ processingBatch, account, log }) {
  const spaceId = processingBatch.spaceId;

  return async ({ text }) => {
    log?.info?.(
      `[webex:${account.accountId}] inspecting agent processing output`,
      {
        spaceId,
        text,
      }
    );

    let parsed;
    try {
      parsed = parseJsonObjectFromText(text);
    } catch (err) {
      log?.warn?.(
        `[webex:${account.accountId}] agent processing output was not parseable ${JSON.stringify(
          {
            spaceId,
            error: err?.message ?? String(err),
            text,
          }
        )}`
      );
      throw err;
    }

    log?.info?.(
      `[webex:${account.accountId}] parsed agent processing output ${JSON.stringify(
        {
          spaceId,
          conversationUpdates: parsed.conversationUpdates?.length ?? 0,
          newConversations: parsed.newConversations?.length ?? 0,
          untrackedMessageIds: parsed.untrackedMessageIds?.length ?? 0,
          responseNeeded: parsed.responseDecision?.needed ?? null,
        }
      )}`
    );

    try {
      return handleProcessingResult({
        result: parsed,
        processingBatch,
        account,
        log,
      });
    } catch (err) {
      log?.error?.(
        `[webex:${account.accountId}] failed to handle processing result ${JSON.stringify(
          {
            spaceId,
            result: parsed,
            error: err?.message ?? String(err),
          }
        )}`
      );

      throw err;
    }
  };
}

module.exports = {
  makeProcessingResultHandler,
  handleProcessingResult,
  applyConversationResult,
};

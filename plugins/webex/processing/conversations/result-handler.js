// ********* PROCESSING/CONVERSATIONS/RESULT-HANDLER.JS *********
'use strict';

const { parseJsonObjectFromText } = require('../../utils/parse-json');
const { validateConversationProcessingResult } = require('./validate-result');
const { getConversations } = require('../../context/conversations-store');
const { updateConversationsFromResult } = require('./update-from-result');
const { extractItemsFromBatch } = require('../items/extract-from-batch');
const { sendWebexMessage } = require('../../send');

async function sendResponseDecision({
  responseDecision,
  spaceId,
  account,
  log,
  sendMessage = sendWebexMessage,
}) {
  if (!responseDecision?.needed) return { sent: false };

  const text = String(responseDecision.message ?? '').trim();
  if (!text) {
    throw new Error(
      'responseDecision.message must be non-empty when responseDecision.needed is true'
    );
  }

  const replyToId = String(responseDecision.replyToId ?? '').trim() || undefined;
  const message = await sendMessage({
    token: account.config.token,
    to: spaceId,
    text,
    parentId: replyToId,
  });

  log?.info?.(
    `[webex:${account.accountId}] sent response decision ${JSON.stringify({
      spaceId,
      messageId: message.id,
      replyToId: replyToId ?? null,
    })}`
  );

  return { sent: true, messageId: message.id };
}

// Make handler for parsing batch conversation processing result
function makeConversationProcessingResultHandler({
  processingBatch,
  existingConversations,
  account,
  log,
}) {
  const spaceId = processingBatch.spaceId;

  return async ({ text }) => {
    log?.info?.(
      `[webex:${account.accountId}] inspecting conversation processing output`,
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
        `[webex:${account.accountId}] conversation processing output was not parseable ${JSON.stringify(
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
      `[webex:${account.accountId}] parsed conversation processing output ${JSON.stringify(
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
      return handleConversationProcessingResult({
        conversationProcessingResult: parsed,
        processingBatch,
        existingConversations,
        account,
        log,
      });
    } catch (err) {
      log?.error?.(
        `[webex:${account.accountId}] failed to handle conversation processing result ${JSON.stringify(
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

// Handle result
async function handleConversationProcessingResult({
  conversationProcessingResult,
  processingBatch,
  existingConversations,
  account,
  log,
}) {
  if (!processingBatch) throw new Error('processingBatch is required');
  if (!processingBatch.spaceId)
    throw new Error('processingBatch.spaceId is required');
  if (!account) throw new Error('account is required');

  // Validate
  const errors = validateConversationProcessingResult(
    conversationProcessingResult,
    {
      processingBatch,
      existingConversations,
    }
  );

  if (errors.length > 0) {
    throw new Error(`invalid processing result: ${errors.join('; ')}`);
  }

  // Update conversations
  const { touchedConversationIds } = await updateConversationsFromResult({
    processingBatch,
    conversationProcessingResult,
    account,
    log,
  });

  const responseDelivery = await sendResponseDecision({
    responseDecision: conversationProcessingResult.responseDecision,
    spaceId: processingBatch.spaceId,
    account,
    log,
  });

  // Extract items
  const itemExtractionResult = await extractItemsFromBatch({
    processingBatch,
    touchedConversationIds,
    account,
    log,
  });

  return {
    ok: true,
    result: conversationProcessingResult,
    conversationsUpdated:
      conversationProcessingResult.conversationUpdates.length,
    conversationsCreated: conversationProcessingResult.newConversations.length,
    touchedConversationIds,
    responseDelivery,
    itemExtraction: {
      skipped: itemExtractionResult.skipped,
      candidateItemCount: itemExtractionResult.candidateItems?.length ?? 0,
    },
  };
}

module.exports = {
  makeConversationProcessingResultHandler,
  sendResponseDecision,
};

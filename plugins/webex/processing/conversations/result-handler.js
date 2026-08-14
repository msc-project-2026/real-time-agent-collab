// ********* PROCESSING/CONVERSATIONS/RESULT-HANDLER.JS *********
'use strict';

const { parseJsonObjectFromText } = require('../../utils/parse-json');
const { validateConversationProcessingResult } = require('./validate-result');
const { getConversations } = require('../../context/conversations-store');
const { updateConversationsFromResult } = require('./update-from-result');
const { extractItemsFromBatch } = require('../items/extract-from-batch');

// Make handler for parsing batch conversation processing result
function makeConversationProcessingResultHandler({
  processingBatch,
  existingConversations,
  account,
  log,
}) {
  const spaceId = processingBatch?.spaceId;

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
      return await handleConversationProcessingResult({
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
    itemExtraction: {
      skipped: itemExtractionResult.skipped,
      candidateItemCount: itemExtractionResult.candidateItems?.length ?? 0,
    },
  };
}

module.exports = {
  makeConversationProcessingResultHandler,
};

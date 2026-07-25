// ********* PROCESSING/CONVERSATIONS/RESULT-HANDLER.JS *********
'use strict';

const { parseJsonObjectFromText } = require('../../utils/parse-json');
const { validateConversationProcessingResult } = require('./validate-result');
const { getConversations } = require('../../context/conversations-store');
const { updateConversationsFromResult } = require('./update-from-result');
const { extractItemsFromResult } = require('../items/extract-from-result');

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
      return handleConversationProcessingResult({
        processingResult: parsed,
        processingBatch,
        existingConversations,
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

// Handle result
async function handleConversationProcessingResult({
  processingResult,
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
  const errors = validateConversationProcessingResult(processingResult, {
    processingBatch,
    existingConversations,
  });

  if (errors.length > 0) {
    throw new Error(`invalid processing result: ${errors.join('; ')}`);
  }

  // Update conversations
  const { touchedConversationIds } = await updateConversationsFromResult({
    processingBatch,
    processingResult,
    account,
    log,
  });

  // Extract items
  const itemExtractionResult = await extractItemsFromResult({
    processingBatch,
    processingResult,
    touchedConversationIds,
    account,
    log,
  });

  return {
    ok: true,
    result: processingResult,
    conversationsUpdated: processingResult.conversationUpdates.length,
    conversationsCreated: processingResult.newConversations.length,
    touchedConversationIds,
    itemExtraction: {
      skipped: itemExtractionResult.skipped,
      candidateItemCount: itemExtractionResult.candidateItems?.length ?? 0,
    },
  };
}

module.exports = {
  handleConversationProcessingResult,
  handleConversationProcessingResult,
};

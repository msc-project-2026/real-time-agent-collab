// ********* PROCESSING/ITEMS/RESULT-HANDLER.JS *********
'use strict';

const { parseJsonObjectFromText } = require('../../utils/parse-json');
const { validateItemExtractionResult } = require('./validate-result');
const { updateItemsFromResult } = require('./update-from-result');

function makeItemExtractionResultHandler({
  processingBatch,
  touchedConversations,
  candidateItems,
  account,
  log,
}) {
  const spaceId = processingBatch?.spaceId;
  const batchId = processingBatch?.batchId;

  return async ({ text }) => {
    log?.info?.(
      `[webex:${account.accountId}] inspecting item extraction output`,
      {
        spaceId,
        batchId,
        text,
      }
    );

    let parsed;

    try {
      parsed = parseJsonObjectFromText(text);
    } catch (err) {
      log?.warn?.(
        `[webex:${account.accountId}] item extraction output was not parseable ${JSON.stringify(
          {
            spaceId,
            batchId,
            error: err?.message ?? String(err),
            text,
          }
        )}`
      );
      throw err;
    }

    log?.info?.(
      `[webex:${account.accountId}] parsed item extraction output ${JSON.stringify(
        {
          spaceId,
          batchId,
          itemUpdates: parsed.itemUpdates?.length ?? 0,
          newItems: parsed.newItems?.length ?? 0,
          ignoredMessageIds: parsed.ignoredMessageIds?.length ?? 0,
        }
      )}`
    );

    try {
      return await handleItemExtractionResult({
        itemExtractionResult: parsed,
        processingBatch,
        touchedConversations,
        candidateItems,
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
async function handleItemExtractionResult({
  itemExtractionResult,
  processingBatch,
  touchedConversations,
  candidateItems,
  account,
  log,
}) {
  if (!processingBatch) throw new Error('processingBatch is required');
  if (!processingBatch.spaceId)
    throw new Error('processingBatch.spaceId is required');
  if (!account) throw new Error('account is required');

  // Validate
  const errors = validateItemExtractionResult(itemExtractionResult, {
    processingBatch,
    touchedConversations,
    candidateItems,
  });

  if (errors.length > 0) {
    throw new Error(`invalid item extraction result: ${errors.join('; ')}`);
  }

  // Update
  const { touchedItemIds } = await updateItemsFromResult({
    processingBatch,
    itemExtractionResult,
    account,
    log,
  });

  return {
    ok: true,
    itemExtractionResult,
    touchedItemIds,
  };
}

module.exports = {
  makeItemExtractionResultHandler,
};

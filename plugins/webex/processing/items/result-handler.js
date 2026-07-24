// ********* PROCESSING/ITEMS/RESULT-HANDLER.JS *********
'use strict';

const { parseJsonObjectFromText } = require('../../utils/parse-json');

function makeItemExtractionResultHandler({ processingBatch, account, log }) {
  const spaceId = processingBatch.spaceId;
  const batchId = processingBatch.batchId;

  return async ({ text }) => {
    log?.info?.(
      `[webex:${account.accountId}] inspecting item extraction output`,
      {
        spaceId,
        batchId,
        text,
      }
    );

    let itemExtractionResult;

    try {
      itemExtractionResult = parseJsonObjectFromText(text);
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
          itemUpdates: itemExtractionResult.itemUpdates?.length ?? 0,
          newItems: itemExtractionResult.newItems?.length ?? 0,
          ignoredMessageIds:
            itemExtractionResult.ignoredMessageIds?.length ?? 0,
        }
      )}`
    );

    return {
      ok: true,
      itemExtractionResult,
    };
  };
}

module.exports = {
  makeItemExtractionResultHandler,
};

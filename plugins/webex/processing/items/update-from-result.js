// ********* PROCESSING/ITEMS/UPDATE-FROM-RESULT.JS *********
'use strict';

const { asArray, cleanString, unique } = require('../../utils/values');
const {
  createItemId,
  readItemsState,
  writeItemsState,
} = require('../../context/items-store');

function applyItemExtractionResult({ state, result }) {
  const now = new Date().toISOString();

  const items = [...asArray(state.items)];
  const touchedItemIds = [];

  for (const update of asArray(result.itemUpdates)) {
    const index = items.findIndex((item) => item.id === update.itemId);

    if (index === -1) continue;

    const existing = items[index];

    items[index] = {
      ...existing,
      status: cleanString(update.status) || existing.status,
      title: cleanString(update.title) || existing.title,
      description: cleanString(update.description) || existing.description,
      owner:
        update.owner === null || update.owner === undefined
          ? (existing.owner ?? null)
          : update.owner,
      conversationIds: unique([
        ...asArray(existing.conversationIds),
        ...asArray(update.conversationIds),
      ]),
      evidenceMessageIds: unique([
        ...asArray(existing.evidenceMessageIds),
        ...asArray(update.evidenceMessageIds),
      ]),
      updatedAt: now,
    };

    touchedItemIds.push(existing.id);
  }

  for (const item of asArray(result.newItems)) {
    const id = createItemId();

    items.push({
      id,
      type: cleanString(item.type),
      status: cleanString(item.status) || 'open',
      title: cleanString(item.title),
      description: cleanString(item.description),
      owner: item.owner ?? null,
      conversationIds: unique(asArray(item.conversationIds)),
      evidenceMessageIds: unique(asArray(item.evidenceMessageIds)),
      createdAt: now,
      updatedAt: now,
    });

    touchedItemIds.push(id);
  }

  return {
    newState: {
      ...state,
      items,
      updatedAt: now,
    },
    touchedItemIds: unique(touchedItemIds),
  };
}

async function updateItemsFromResult({
  processingBatch,
  itemExtractionResult,
  account,
  log,
}) {
  if (!processingBatch) throw new Error('processingBatch is required');
  if (!processingBatch.spaceId) {
    throw new Error('processingBatch.spaceId is required');
  }
  if (!itemExtractionResult) {
    throw new Error('itemExtractionResult is required');
  }
  if (!account) throw new Error('account is required');

  const spaceId = processingBatch.spaceId;
  const state = await readItemsState({ spaceId });

  const { newState, touchedItemIds } = applyItemExtractionResult({
    state,
    result: itemExtractionResult,
  });

  await writeItemsState({
    spaceId,
    state: newState,
  });

  log?.info?.(
    `[webex:${account.accountId}] updated item state from extraction result ${JSON.stringify(
      {
        spaceId,
        batchId: processingBatch.batchId,
        itemUpdates: itemExtractionResult.itemUpdates.length,
        newItems: itemExtractionResult.newItems.length,
        touchedItemIds,
        touchedItemCount: touchedItemIds.length,
      }
    )}`
  );

  return {
    touchedItemIds,
  };
}

module.exports = {
  applyItemExtractionResult,
  updateItemsFromResult,
};

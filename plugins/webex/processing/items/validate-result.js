// ********* PROCESSING/ITEMS/VALIDATE-RESULT.JS *********
'use strict';

const { asArray, cleanString } = require('../../utils/normalise');

const VALID_TYPES = new Set([
  'task',
  'issue',
  'question',
  'decision',
  'risk',
  'dependency',
  'coordination',
]);

const VALID_STATUSES = new Set([
  'open',
  'in_progress',
  'blocked',
  'resolved',
  'stale',
]);

function validateItemExtractionResult(
  result,
  { processingBatch, touchedConversations, candidateItems }
) {
  const errors = [];

  if (!result || typeof result !== 'object') {
    return ['itemExtractionResult must be a JSON object'];
  }

  if (!processingBatch) errors.push('processingBatch is required');

  if (!Array.isArray(result.itemUpdates)) {
    errors.push('itemUpdates must be an array');
  }

  if (!Array.isArray(result.newItems)) {
    errors.push('newItems must be an array');
  }

  const messageIds = new Set(
    asArray(processingBatch?.messages)
      .map((message) => message.id)
      .filter(Boolean)
  );

  const conversationIds = new Set(
    asArray(touchedConversations)
      .map((conversation) => conversation.id)
      .filter(Boolean)
  );

  const itemIds = new Set(
    asArray(candidateItems)
      .map((item) => item.id)
      .filter(Boolean)
  );

  for (const update of asArray(result.itemUpdates)) {
    if (!itemIds.has(update.itemId)) {
      errors.push(`unknown itemId: ${update.itemId}`);
    }

    if (!VALID_STATUSES.has(update.status)) {
      errors.push(`invalid item update status: ${update.status}`);
    }

    if (
      !Array.isArray(update.evidenceMessageIds) ||
      update.evidenceMessageIds.length === 0
    ) {
      errors.push(`item update missing evidenceMessageIds: ${update.itemId}`);
    }

    for (const messageId of asArray(update.evidenceMessageIds)) {
      if (!messageIds.has(messageId)) {
        errors.push(`item update uses unknown evidenceMessageId: ${messageId}`);
      }
    }

    for (const conversationId of asArray(update.conversationIds)) {
      if (!conversationIds.has(conversationId)) {
        errors.push(
          `item update uses unknown conversationId: ${conversationId}`
        );
      }
    }
  }

  for (const item of asArray(result.newItems)) {
    if (!VALID_TYPES.has(item.type)) {
      errors.push(`invalid new item type: ${item.type}`);
    }

    if (!VALID_STATUSES.has(item.status)) {
      errors.push(`invalid new item status: ${item.status}`);
    }

    if (!cleanString(item.title)) {
      errors.push('new item missing title');
    }

    if (!cleanString(item.description)) {
      errors.push(`new item missing description: ${item.title}`);
    }

    if (
      !Array.isArray(item.evidenceMessageIds) ||
      item.evidenceMessageIds.length === 0
    ) {
      errors.push(`new item missing evidenceMessageIds: ${item.title}`);
    }

    if (
      !Array.isArray(item.conversationIds) ||
      item.conversationIds.length === 0
    ) {
      errors.push(`new item missing conversationIds: ${item.title}`);
    }

    for (const messageId of asArray(item.evidenceMessageIds)) {
      if (!messageIds.has(messageId)) {
        errors.push(`new item uses unknown evidenceMessageId: ${messageId}`);
      }
    }

    for (const conversationId of asArray(item.conversationIds)) {
      if (!conversationIds.has(conversationId)) {
        errors.push(`new item uses unknown conversationId: ${conversationId}`);
      }
    }
  }

  return errors;
}

module.exports = {
  validateItemExtractionResult,
};

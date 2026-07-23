// ********* PROCESSING/VALIDATE-RESULT.JS *********
'use strict';

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

// *** Validate result
function validateProcessingResult(result, { processingBatch }) {
  const errors = [];

  if (!result || typeof result !== 'object') {
    return ['result must be a JSON object'];
  }

  if (!Array.isArray(result.conversationUpdates)) {
    errors.push('conversationUpdates must be an array');
  }

  if (!Array.isArray(result.newConversations)) {
    errors.push('newConversations must be an array');
  }

  if (!Array.isArray(result.untrackedMessageIds)) {
    errors.push('untrackedMessageIds must be an array');
  }

  if (
    !result.responseDecision ||
    typeof result.responseDecision !== 'object' ||
    typeof result.responseDecision.needed !== 'boolean'
  ) {
    errors.push('responseDecision.needed must be a boolean');
  }

  const messageIds = new Set(
    asArray(processingBatch.messages)
      .map((message) => message.id)
      .filter(Boolean)
  );

  const conversationIds = new Set(
    asArray(processingBatch.conversations)
      .map((conv) => conv.id)
      .filter(Boolean)
  );

  for (const update of asArray(result.conversationUpdates)) {
    if (!conversationIds.has(update.conversationId)) {
      errors.push(`unknown conversationId: ${update.conversationId}`);
    }

    for (const messageId of asArray(update.messageIds)) {
      if (!messageIds.has(messageId)) {
        errors.push(`conversation update uses unknown messageId: ${messageId}`);
      }
    }

    if (!cleanString(update.summary)) {
      errors.push(
        `conversation update missing summary: ${update.conversationId}`
      );
    }
  }

  for (const conversation of asArray(result.newConversations)) {
    if (!cleanString(conversation.topic)) {
      errors.push('new conversation missing topic');
    }

    if (!cleanString(conversation.summary)) {
      errors.push(`new conversation missing summary: ${conversation.topic}`);
    }

    for (const messageId of asArray(conversation.messageIds)) {
      if (!messageIds.has(messageId)) {
        errors.push(`new conversation uses unknown messageId: ${messageId}`);
      }
    }
  }

  for (const messageId of asArray(result.untrackedMessageIds)) {
    if (!messageIds.has(messageId)) {
      errors.push(
        `untrackedMessageIds contains unknown messageId: ${messageId}`
      );
    }
  }

  return errors;
}

module.exports = {
  validateProcessingResult,
  asArray,
  cleanString,
};

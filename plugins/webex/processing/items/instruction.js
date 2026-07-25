// ********* PROCESSING/ITEMS/INSTRUCTION.JS *********
'use strict';

function formatBatchMetadataForItemExtractionPrompt({ processingBatch }) {
  return {
    spaceId: processingBatch.spaceId,
    batchId: processingBatch.batchId,
    messageCount: processingBatch.messageCount,
  };
}

function formatBatchMessagesForItemExtractionPrompt({ processingBatch }) {
  return Array.isArray(processingBatch.messages)
    ? processingBatch.messages.map((message) => ({
        id: message.id,
        text: message.text ?? '',
        senderName:
          message.senderName ?? message.personEmail ?? message.personId ?? null,
        createdAt: message.created ?? null,
        parentId: message.parentId ?? null,
      }))
    : [];
}

function formatConversationsForItemExtractionPrompt({ conversations }) {
  return Array.isArray(conversations)
    ? conversations.map((conversation) => ({
        id: conversation.id,
        topic: conversation.topic,
        summary: conversation.summary,
        status: conversation.status,
      }))
    : [];
}

function formatItemsForItemExtractionPrompt({ items }) {
  return Array.isArray(items)
    ? items.map((item) => ({
        id: item.id,
        type: item.type,
        status: item.status,
        title: item.title,
        description: item.description,
        owner: item.owner ?? null,
        conversationIds: Array.isArray(item.conversationIds)
          ? item.conversationIds
          : [],
      }))
    : [];
}

function buildItemExtractionInstruction({
  processingBatch,
  touchedConversations,
  candidateItems,
}) {
  const batchMetadata = formatBatchMetadataForItemExtractionPrompt({
    processingBatch,
  });

  const batchMessages = formatBatchMessagesForItemExtractionPrompt({
    processingBatch,
  });

  const includedConversations = formatConversationsForItemExtractionPrompt({
    conversations: touchedConversations,
  });

  const existingItems = formatItemsForItemExtractionPrompt({
    items: candidateItems,
  });

  return `
## Task

You are extracting operational project items from a batch of Webex space messages.

Read the batch messages, included relevant conversations, and a subset of existing items below. Determine:

1. Which existing item(s), if any, should be updated.
2. Which new item(s), if any, should be created.

### Note

- Operational items are project-relevant tasks, issues, questions, decisions, risks, dependencies, or coordination facts.
- Do not create duplicate items. Prefer updating an existing item when the batch clearly continues, resolves, blocks, or refines it.

### Output

Output exactly **one JSON object**:

\`\`\`json
{
  "itemUpdates": [
    {
      "itemId": "<existing item id>",
      "status": "open|in_progress|blocked|resolved|stale",
      "title": "<updated title, or null>",
      "description": "<updated description, or null>",
      "owner": "<owner, or null>",
      "reason": "<brief reason for the update>",
      "conversationIds": ["<conversation id>"],
      "evidenceMessageIds": ["<message id>"]
    }
  ],
  "newItems": [
    {
      "type": "task|issue|question|decision|risk|dependency|coordination",
      "status": "open|in_progress|blocked|resolved|stale",
      "title": "<short title>",
      "description": "<concise description>",
      "owner": "<owner, or null>",
      "conversationIds": ["<conversation id>"],
      "evidenceMessageIds": ["<message id>"]
    }
  ]
}
\`\`\`

### Rules

- Use only message ids that appear in the batch, conversation ids that appear in the included conversations, and item ids that appear in the existing items.
- Use batch messages as the primary evidence; use included conversations to understand context and assign conversationIds.
- Every new item must have at least one evidenceMessageId.
- Every item update must have at least one evidenceMessageId.
- Do not invent owners, the sender of a message is not automatically the owner. Use null when no owner is explicit.
- Do not create an item for casual chatter, vague interest, or weak speculation.
- Do not include text outside the JSON object.

## Batch 

### Metadata

\`\`\`json
${JSON.stringify(batchMetadata, null, 2)}
\`\`\`

### Messages

\`\`\`json
${JSON.stringify(batchMessages, null, 2)}
\`\`\`

## Included conversations

\`\`\`json
${JSON.stringify(includedConversations, null, 2)}
\`\`\`

## Existing items

\`\`\`json
${JSON.stringify(existingItems, null, 2)}
\`\`\`
`.trim();
}

module.exports = {
  buildItemExtractionInstruction,
};

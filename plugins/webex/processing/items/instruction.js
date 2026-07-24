// ********* PROCESSING/ITEMS/INSTRUCTION.JS *********
'use strict';

function buildItemExtractionInstruction({
  processingBatch,
  touchedConversations,
  candidateItems,
}) {
  return `
## Task

You are extracting operational project items from a batch of Webex space messages.

Read the batch messages, included relevant conversations, and a subset of existing items below. Determine:

1. Which existing item(s), if any, should be updated.
2. Which new item(s), if any, should be created.

Operational items are project-relevant tasks, issues, questions, decisions, risks, dependencies, or coordination facts.

Do not create duplicate items. Prefer updating an existing item when the batch clearly continues, resolves, blocks, or refines it.

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
- Do not invent owners. Use null when no owner is explicit.
- Do not create an item for casual chatter, vague interest, or weak speculation.
- Do not include text outside the JSON object.

## Batch metadata

\`\`\`json
${JSON.stringify(
  {
    spaceId: processingBatch.spaceId,
    batchId: processingBatch.batchId,
    messageCount: processingBatch.messageCount,
  },
  null,
  2
)}
\`\`\`

## Batch messages

\`\`\`json
${JSON.stringify(processingBatch.messages, null, 2)}
\`\`\`

## Included conversations

\`\`\`json
${JSON.stringify(touchedConversations, null, 2)}
\`\`\`

## Existing items

\`\`\`json
${JSON.stringify(candidateItems, null, 2)}
\`\`\`
`.trim();
}

module.exports = {
  buildItemExtractionInstruction,
};

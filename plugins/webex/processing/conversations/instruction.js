// ********* PROCESSING/CONVERSATIONS/INSTRUCTION.JS *********
'use strict';

function formatBatchMetadataForConversationProcessingPrompt({ batch }) {
  return {
    spaceId: batch.spaceId,
    batchId: batch.batchId,
    messageCount: batch.messageCount,
    suggestedReplyToId: batch.suggestedReplyToId,
  };
}

function formatBatchMessagesForConversationProcessingPrompt({ batch }) {
  return Array.isArray(batch.messages)
    ? batch.messages.map((message) => ({
        id: message.id,
        text: message.text ?? '',
        senderName:
          message.senderName ?? message.personEmail ?? message.personId ?? null,
        createdAt: message.created ?? null,
        parentId: message.parentId ?? null,
      }))
    : [];
}

function formatConversationsForConversationProcessingPrompt({ conversations }) {
  return Array.isArray(conversations)
    ? conversations.map((conversation) => ({
        id: conversation.id,
        topic: conversation.topic,
        summary: conversation.summary,
        status: conversation.status,
      }))
    : [];
}

function buildConversationProcessingInstruction({ batch, conversations }) {
  const batchMetadata = formatBatchMetadataForConversationProcessingPrompt({
    batch,
  });
  const batchMessages = formatBatchMessagesForConversationProcessingPrompt({
    batch,
  });
  const existingConversations =
    formatConversationsForConversationProcessingPrompt({
      conversations,
    });

  return `
## Task

You are analysing a batch of Webex space messages.

Read the batch and existing conversations below. Determine:

1. Which existing conversation(s), if any, the batch continues.
2. Whether the batch starts any new conversation(s).
3. Whether any part of the batch is not informative and should not be tracked as a conversation.
4. Whether the agent should send a local response now.

### Note

- The batch may contain messages belonging to different conversations; assess each message or coherent subset of messages and assign the relevant messageIds accordingly.
- A conversation should only be tracked if it may be useful for future project context, coordination, task identification, or direct questions to the agent.
- Avoid creating duplicate conversations. Prefer updating an existing conversation when the batch clearly continues the same issue, decision, question, task, or work topic.

### Output

Output exactly **one JSON object**:

\`\`\`json
{
  "conversationUpdates": [
    {
      "conversationId": "<existing conversation id>",
      "summary": "<updated concise summary of the conversation>",
      "reason": "<brief reason this batch belongs to the conversation>",
      "messageIds": ["<message id>"]
    }
  ],
  "newConversations": [
    {
      "topic": "<short conversation topic>",
      "summary": "<concise summary of the new conversation>",
      "messageIds": ["<message id>"]
    }
  ],
  "untrackedMessageIds": ["<message id>"],
  "responseDecision": {
    "needed": true | false,
    "reason": "<brief reason>",
    "message": "<message to send, or null>",
    "replyToId": "<replyToId, or null>"
  }
}
\`\`\`

### Rules

- Keep conversation summaries concise and topic-level. Do not list every task, decision, or risk in detail; those will be tracked separately as items.
- Use only message ids that appear in the batch.
- Use only conversation ids that appear in the existing conversations.
- If no response is needed, set message and replyToId to null.
- If a response is needed and suggestedReplyToId is available, use it as replyToId.
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

## Existing conversations

\`\`\`json
${JSON.stringify(existingConversations, null, 2)}
\`\`\`
`.trim();
}

module.exports = {
  buildConversationProcessingInstruction,
};

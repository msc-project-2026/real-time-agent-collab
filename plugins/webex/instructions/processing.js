// ********* PROCESSING.JS *********
'use strict';

function buildProcessingInstruction({ batch }) {
  return `
## Task

You are processing a batch of Webex space messages.

Read the batch and existing conversations below. Determine:

1. Which existing conversation(s), if any, the batch continues.
2. Whether the batch starts any new conversation(s).
3. Whether any part of the batch is not informative and should not be tracked as a conversation.
4. Whether the agent should send a local response now.


The batch may contain messages belonging to different conversations; assess each message or coherent subset of messages and assign the relevant messageIds accordingly.

A conversation should only be tracked if it may be useful for future project context, coordination, task identification, or direct questions to the agent.

Avoid creating duplicate conversations. Prefer updating an existing conversation when the batch clearly continues the same issue, decision, question, task, or work topic.

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
- Use only message ids that appear in the batch.
- Use only conversation ids that appear in the existing conversations.
- If no response is needed, set message and replyToId to null.
- If a response is needed and suggestedReplyToId is available, use it as replyToId.
- Do not include text outside the JSON object.

## Batch metadata

\`\`\`json
${JSON.stringify(
  {
    spaceId: batch.spaceId,
    batchId: batch.batchId,
    messageCount: batch.messageCount,
    suggestedReplyToId: batch.suggestedReplyToId,
  },
  null,
  2
)}
\`\`\`

## Batch messages

\`\`\`json
${JSON.stringify(batch.messages, null, 2)}
\`\`\`

## Existing conversations

\`\`\`json
${JSON.stringify(batch.conversations, null, 2)}
\`\`\`
`.trim();
}

module.exports = {
  buildProcessingInstruction,
};

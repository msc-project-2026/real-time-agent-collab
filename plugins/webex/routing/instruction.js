// ********* ROUTING/INSTRUCTION.JS *********
'use strict';

function formatMessageContentForRoutingPrompt({ message }) {
  return message.text ?? '';
}

function formatMessageMetadataForRoutingPrompt({ message, botId }) {
  const botIsMentioned =
    Array.isArray(message.mentionedPeople) &&
    message.mentionedPeople.includes(botId);

  return {
    spaceId: message.roomId,
    senderName: message.personEmail ?? message.personId,
    botIsMentioned,
    threadKey: message.threadKey ?? null,
  };
}

function formatThreadContextForRoutingPrompt({ thread }) {
  return {
    key: thread?.key ?? null,
    kind: thread?.kind ?? null,
    rootMessageId: thread?.rootMessageId ?? null,
    contextWindow: Array.isArray(thread?.contextWindow)
      ? thread.contextWindow.map((message) => ({
          text: message.text ?? '',
          senderName: message.senderName ?? null,
          createdAt: message.createdAt ?? null,
        }))
      : [],
  };
}

function buildRoutingInstruction({ message, botId, thread }) {
  const messageContents = formatMessageContentForRoutingPrompt({ message });
  const messageMetadata = formatMessageMetadataForRoutingPrompt({
    message,
    botId,
  });
  const threadContext = formatThreadContextForRoutingPrompt({ thread });

  return `
## Task

You are routing an inbound group space message by identifying special intents.

By default, messages may still be stored and processed by the normal batch pipeline; special routes only indicate extra handling.

Read the message and identify all special routes that apply.

### Routes

- "recall_request": use when the message asks about previous decisions, current project state, open tasks, risks, issues, or what has been discussed.
- "task_request": use when the message asks the agent/team to create, add, fix, test, implement, check, or follow up on something.
- "config_request": use when the message asks to configure, view, or update this space's settings.

### Output

Output exactly **one JSON object**:

\`\`\`json
{
  "routes": [
    {
      "route": "recall_request" | "task_request" | "config_request",
      "reason": "<brief reason>"
    }
  ]
}
\`\`\`

### Rules
- Return an empty routes array when no special route applies.
- Return multiple routes when the message has multiple special intents.
- Do not include the same route more than once.
- Use the local thread context window below to resolve reference ambiguities in the current message.
- Do not call tools.
- Do not include any text outside the JSON object.

## Local thread context

This is the local thread record for the current message.

- \`kind\` indicates whether the message is in the root/main flow or a Webex thread.
- \`rootMessageId\` is the Webex root message id for threaded replies, or null for the root/main flow.
- \`contextWindow\` contains recent prior messages from this same local thread.

\`\`\`json
${JSON.stringify(threadContext, null, 2)}
\`\`\`

## Webex Message 

### Metadata

\`\`\`json
${JSON.stringify(messageMetadata, null, 2)}
\`\`\`

### Contents

\`\`\`
${messageContents}
\`\`\`
`.trim();
}

module.exports = {
  buildRoutingInstruction,
};

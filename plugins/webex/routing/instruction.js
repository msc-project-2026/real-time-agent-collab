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
  };
}

function buildRoutingInstruction({ message, botId }) {
  const messageContents = formatMessageContentForRoutingPrompt({ message });
  const messageMetadata = formatMessageMetadataForRoutingPrompt({
    message,
    botId,
  });

  return `
## Task

You are routing an inbound group space message by identifying special intents.

By default, messages may still be stored and processed by the normal batch pipeline; special routes only indicate extra handling.

Read the message and identify all special routes that apply.

### Routes

- "recall_question": use when the message asks about previous decisions, current project state, open tasks, risks, issues, or what has been discussed.
- "task_request": use when the message asks the agent/team to create, add, fix, test, implement, check, or follow up on something.
- "config_request": use when the message asks to configure, view, or update this space's settings.

### Output

Output exactly **one JSON object**:

\`\`\`json
{
  "routes": [
    {
      "route": "recall_question" | "task_request" | "config_request",
      "reason": "<brief reason>"
    }
  ]
}
\`\`\`

### Rules
- Return an empty routes array when no special route applies.
- Return multiple routes when the message has multiple special intents.
- Do not include the same route more than once.
- Do not call tools.
- Do not include any text outside the JSON object.

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

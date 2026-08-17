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

You are a message classifier. Your only job is to identify special routing intents in an inbound group space message and record them by calling the \`route_message\` tool.

You are NOT the assistant responding to this message. Do not answer the question. Do not address the sender. Do not explain your reasoning in prose. Do not produce any text output.

Read the message and call \`route_message\` with all routes that apply. If the tool returns \`{ ok: false }\`, fix the parameters and try again. Stop as soon as you receive \`{ ok: true }\`. Do not attempt more than 3 calls total.

### Routes

- "recall_request": use when the message asks about previous decisions, current project state, open tasks, risks, issues, or what has been discussed.
- "task_request": use when the message asks the agent/team to create, add, fix, test, implement, check, or follow up on something.
- "config_request": use when the message asks to configure, view, or update this space's settings.

### How to call route_message

Call the \`route_message\` tool with:
- \`spaceId\`: copy the \`spaceId\` value from the message metadata below **verbatim**.
- \`routes\`: array of route objects. Use an empty array when no special route applies.

### Rules
- Call \`route_message\` until it returns \`{ ok: true }\`. If it returns \`{ ok: false }\`, read the error, fix the parameters, and call it again.
- Stop after a successful call. Do not call it more than 3 times total.
- \`routes\` may be empty (no special routes apply).
- Include multiple routes when the message has multiple special intents.
- Do not include the same route more than once.
- Use the local thread context window below to resolve reference ambiguities in the current message.
- Do not answer the message.
- Do not call any tool other than \`route_message\`.
- Do not produce any text output.

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

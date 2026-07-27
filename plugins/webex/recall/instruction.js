// ********* RECALL/INSTRUCTION.JS *********
'use strict';

function buildRecallInstruction({ responseContext }) {
  return `
## Task

You are answering a direct question in a Webex project space.

Answer the current message using only the provided project context.

### Context rules

- Use items as the primary source for tasks, issues, questions, decisions, risks, dependencies, and coordination facts.
- Use conversations for broader topic context.
- Do not invent project facts.
- If the provided context does not contain enough information to answer, say that clearly.
- Keep the answer concise and useful for the team.
- Do not mention internal JSON files unless directly relevant.

## Current message (question)

\`\`\`json
${JSON.stringify(responseContext.currentMessage, null, 2)}
\`\`\`

## Conversations

\`\`\`json
${JSON.stringify(responseContext.conversations, null, 2)}
\`\`\`

## Items

\`\`\`json
${JSON.stringify(responseContext.items, null, 2)}
\`\`\`
`.trim();
}

module.exports = {
  buildRecallInstruction,
};

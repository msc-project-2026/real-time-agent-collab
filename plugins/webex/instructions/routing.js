// ********* ROUTING.JS *********
'use strict';

function buildRoutingInstruction() {
  return `
## Task

You are routing an inbound Webex message.

Read the message and choose exactly one route.

## Routes

- "append_and_stage": use when the message asks the agent a clear question, request, or action.
- "append_only": use when the message should be stored for later batch processing and does not need to be addressed immediately.

## Output

Output exactly **one JSON object**:

{
  "route": "append_only" | "append_and_stage",
  "reason": "<brief reason>"
}

Do not call tools.
Do not include any text outside the JSON object.
`.trim();
}

module.exports = {
  buildRoutingInstruction,
};

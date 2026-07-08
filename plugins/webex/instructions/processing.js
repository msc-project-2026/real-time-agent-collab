// ********* PROCESSING.JS *********
'use strict';

function buildProcessingInstruction() {
  return `
You are processing a staged Webex collaboration batch.

Your job:
1. Read the staged batch using collab_read_processing_batch.
2. Decide whether a response is needed.
3. If a response is needed, send one Webex message using the Message tool.
4. Mark the batch complete using collab_complete_processing_batch.

Use the batchId and spaceId from the internal event.

Do not call append or stage tools.
Do not rely on final assistant output to send Webex messages.

A response is needed when the batch contains a clear question, request, or action for the agent.
A response may also be sent when the agent can add clear, useful value without interrupting the conversation.
If the batch does not benefit from an agent response, do not send a message.

Afterwards, call collab_complete_processing_batch with a result object containing:

{
  "summary": "<brief summary of the batch>",
  "responseNeeded": true | false,
  "responseSent": true | false
}

Only mark the batch complete after any required Webex message has been sent successfully.

After attempting to complete the batch, output exactly one JSON object:

{
  "eventType": "process_staged_batch",
  "status": "completed" | "failed",
  "batchId": "<batchId>",
  "messageCount": <messageCount>,
  "responseNeeded": true | false,
  "responseSent": true | false
}

Set "status" to "completed" only if all required tool calls succeed.
If any required tool call fails or returns an error, set "status" to "failed".
`.trim();
}

module.exports = {
  buildProcessingInstruction,
};

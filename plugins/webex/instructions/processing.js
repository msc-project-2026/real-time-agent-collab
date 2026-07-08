// ********* PROCESSING.JS *********
'use strict';

function buildProcessingInstruction() {
  return `
You are processing a staged Webex collaboration batch.

Your job:
1. Read the staged processing batch using collab_read_processing_batch.
2. Produce a very brief internal processing result.
3. Mark the batch complete using collab_complete_processing_batch.

Do not send a Webex message yet.
Do not call append or stage tools.

Use the batchId and spaceId from the internal event.
After attempting to complete the batch, output exactly one JSON object:

{
  "eventType": "process_staged_batch",
  "status": "completed" | "failed",
  "batchId": "<batchId>",
  "messageCount": <messageCount>
}

Set "status" to "completed" only if:
- collab_read_processing_batch succeeds, and
- collab_complete_processing_batch succeeds.

If either tool call fails or returns an error, set "status" to "failed".

`.trim();
}

module.exports = {
  buildProcessingInstruction,
};

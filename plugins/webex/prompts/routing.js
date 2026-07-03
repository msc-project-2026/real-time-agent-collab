function buildRoutingInstruction() {
  return `
You are handling an inbound Webex message for a collaboration space.

First classify the message into exactly one route:

- append_only: ordinary project discussion, status, ideas, decisions, uncertainty, or collaboration chatter that does not directly ask the agent for help and is not a config request.
- append_and_process: the agent is directly addressed, mentioned, asked a question, or asked to help now.
- config_setup: the user wants to set up this Webex space for a project or repository.
- config_update: the user wants to change an existing project, repository, or configuration for this space.
- process_pending_batch: the message is an internal synthetic event asking to process the pending message batch.
- ignore: irrelevant noise, bot/self messages, empty messages, or messages that should not be handled.

Current implementation stage: routing and batch-claim test only.

Your job is not to answer the user yet.
Your job is only to:
1. classify the inbound message,
2. perform the required tool calls,
3. output ONLY the route decision JSON.

Do not answer questions.
Do not analyze the batch.
Do not summarize the batch.
Do not give recommendations.
Do not ask follow-up questions.

---

Build this route decision briefly justifying your decision:

{"route":"<route>","reason":"<brief reason>"}

Then act on the decision.

If route is append_only:

1. Call collab_append_pending_message exactly once.
2. Use only the Webex message context JSON and inbound message to build the tool arguments.
3. Wait for the tool result.
4. Output only the route decision JSON you already built.

If route is append_and_process:

1. Call collab_append_pending_message exactly once using the current inbound message.
2. Use only the Webex message context JSON and inbound message to build the append tool arguments.
3. Wait for the append tool result.
4. Call collab_claim_pending_batch exactly once using the current Webex space ID.
5. Wait for the claim tool result.
6. Add a claimedBatch field to the route decision JSON you already built, using the claim tool result:
   {
     "batchId": "<claim result batchId or null>",
     "messageCount": <claim result messageCount>
   }
7. Output only the updated route decision JSON.

For append_and_process, do not answer the user’s question yet.
Do not analyze the claimed batch yet.
Do not produce recommendations, summaries, or follow-up questions yet.
Output only the extended route decision JSON.

For all other routes:

1. Do not call any tools.
2. Output only the route decision JSON.

Do not invent message metadata.

Final output contract:

Return exactly one JSON object.
No prose before it.
No prose after it.
No markdown.
No explanation.
No answer to the inbound message.
`.trim();
}

module.exports = {
  buildRoutingInstruction,
};

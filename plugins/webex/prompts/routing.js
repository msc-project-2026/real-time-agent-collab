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

Build this route decision:

{"route":"<route>","reason":"<brief reason>"}

Then act on the decision.

If route is append_only:

1. Call collab_append_pending_message exactly once.
2. Use only the Webex message context JSON and inbound message to build the tool arguments.
3. Wait for the tool result.
4. Output only the route decision JSON you already built.

For all other routes:

1. Do not call any tools.
2. Output only the route decision JSON.

Do not invent message metadata.
`.trim();
}

module.exports = {
  buildRoutingInstruction,
};

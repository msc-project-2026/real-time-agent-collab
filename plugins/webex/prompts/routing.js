function buildRoutingInstruction() {
  return `
You are handling an inbound Webex message for a collaboration space.

First classify the message into exactly one route:

- append_only: ordinary project discussion, status, ideas, decisions, uncertainty, or collaboration chatter that does not directly ask the agent for help and is not a config request.
- append_and_process: the agent is directly addressed, mentioned, asked a question, or asked to help now.
- config_setup: the user wants to set up this Webex space for a project/repository.
- config_update: the user wants to change an existing project/repository/configuration for this space.
- process_pending_batch: the message is an internal synthetic event asking to process the pending message batch.
- ignore: irrelevant noise, bot/self messages, empty messages, or messages that should not be handled.

For this first implementation:

If route is append_only:
- Call collab_append_pending_message exactly once.
- Use the Webex message context JSON to build the tool arguments.
For all routes, including append_only:
- Finish by outputting only this JSON:
  {"route":"<route>","reason":"<brief reason>"}

Do not call any tools for routes other than append_only.
Do not invent message metadata. Use only the Webex message context and inbound message.
`.trim();
}

module.exports = {
  buildRoutingInstruction,
};

// Records the agent's routing/classification decision for an inbound Webex
// message. This replaces the previous pattern of printing the decision as JSON
// into the reply text, which leaked the control artifact into the Webex space.
//
// The decision now travels on the tool-call channel: it forces the agent to
// classify before it acts (scaffolding) and gives us a structured, reliable
// record for logging — while the agent's visible text stays reserved for the
// human reply. Nothing this tool receives is ever shown to users.
function routeDecisionTool() {
  return {
    name: 'collab_route_decision',
    description:
      'Record your routing decision for the current inbound Webex message BEFORE acting on it. ' +
      'Call this exactly once, first, with the chosen route and a brief reason. ' +
      'This is an internal control record — it is never shown to users, so do NOT also print ' +
      'the route, the reason, or any JSON in your reply text.',
    parameters: {
      type: 'object',
      properties: {
        spaceId: {
          type: 'string',
          description: 'The Webex space (room) ID from the message context.',
        },
        route: {
          type: 'string',
          enum: [
            'append_only',
            'append_and_process',
            'config_setup',
            'config_update',
            'process_pending_batch',
            'ignore',
          ],
          description: 'The single route that best classifies this message.',
        },
        reason: {
          type: 'string',
          description: 'Brief justification for the chosen route.',
        },
      },
      required: ['spaceId', 'route', 'reason'],
      additionalProperties: false,
    },
    async execute(toolUseId, params) {
      const { spaceId, route, reason } = params ?? {};
      console.log(
        `[webex:route] spaceId=${spaceId ?? 'unknown'} route=${route ?? 'unknown'} ` +
          `reason=${JSON.stringify(reason ?? '')}`
      );
      return { ok: true, route: route ?? null };
    },
  };
}

module.exports = {
  routeDecisionTool,
};

const { claimPendingBatch } = require('../storage/claim.js');

function claimPendingBatchTool() {
  return {
    name: 'collab_claim_pending_batch',
    description:
      'Claim this Webex space’s pending collab message buffer into a processing batch and return the claimed messages.',
    parameters: {
      type: 'object',
      properties: {
        spaceId: { type: 'string' },
      },
      required: ['spaceId'],
      additionalProperties: false,
    },
    async execute(toolUseId, params) {
      const { spaceId } = params ?? {};

      return claimPendingBatch({ spaceId });
    },
  };
}

module.exports = {
  claimPendingBatchTool,
};

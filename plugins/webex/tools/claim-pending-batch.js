// ********* CLAIM-PENDING-BATCH.JS *********
'use strict';

const { claimPendingBatch } = require('../lifecycle/claim.js');

function claimPendingBatchTool() {
  return {
    name: 'collab_claim_pending_batch',
    description:
      'Claim this Webex space’s pending collab message buffer into a processing batch and return the claimed messages. If no pending messages exist, this succeeds as a no-op.',
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

      const result = await claimPendingBatch({ spaceId });

      console.info('[webex] collab_claim_pending_batch result', {
        spaceId,
        claimed: result.claimed,
        batchId: result.batchId,
        messageCount: result.messageCount,
      });

      return result;
    },
  };
}

module.exports = {
  claimPendingBatchTool,
};

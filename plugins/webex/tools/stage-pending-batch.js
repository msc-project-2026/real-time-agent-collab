// ********* STAGE-PENDING-BATCH.JS *********
'use strict';

const { stagePendingBatch } = require('../lifecycle/stage-pending.js');

function stagePendingBatchTool() {
  return {
    name: 'collab_stage_pending_batch',
    description:
      "Stage this Webex space's pending collab message buffer into a processing batch and return the staged messages. If no pending messages exist, this succeeds as a no-op.",
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

      const result = await stagePendingBatch({ spaceId });

      console.info('[webex] collab_stage_pending_batch result', {
        spaceId,
        staged: result.staged,
        batchId: result.batchId,
        messageCount: result.messageCount,
      });

      return result;
    },
  };
}

module.exports = {
  stagePendingBatchTool,
};

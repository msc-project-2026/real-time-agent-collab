// ********* COMPLETE_PROCESSING-BATCH.JS *********
'use strict';

const { completeProcessingBatch } = require('../lifecycle/complete');

function completeProcessingBatchTool() {
  return {
    name: 'collab_complete_processing_batch',
    description:
      'Mark a processing batch as complete by moving it from processing storage to processed storage and writing completion metadata.',
    parameters: {
      type: 'object',
      properties: {
        spaceId: { type: 'string' },
        batchId: { type: 'string' },
        result: {
          type: 'object',
          additionalProperties: true,
        },
      },
      required: ['spaceId', 'batchId'],
      additionalProperties: false,
    },
    async execute(toolUseId, params) {
      const { spaceId, batchId, result } = params ?? {};

      const completed = await completeProcessingBatch({
        spaceId,
        batchId,
        result,
      });

      console.info('[webex] collab_complete_processing_batch result', {
        spaceId,
        batchId,
        completedAt: completed.completedAt,
      });

      return completed;
    },
  };
}

module.exports = {
  completeProcessingBatchTool,
};

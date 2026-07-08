// ********* READ_PROCESSING-BATCH.JS *********
'use strict';

const { readProcessingBatch } = require('../lifecycle/read-processing');

function readProcessingBatchTool() {
  return {
    name: 'collab_read_processing_batch',
    description:
      'Read a staged processing batch for a Webex space. Returns the normalized messages from processing/<batchId>.jsonl.',
    parameters: {
      type: 'object',
      properties: {
        spaceId: { type: 'string' },
        batchId: { type: 'string' },
      },
      required: ['spaceId', 'batchId'],
      additionalProperties: false,
    },
    async execute(toolUseId, params) {
      const { spaceId, batchId } = params ?? {};
      const result = await readProcessingBatch({ spaceId, batchId });

      console.info('[webex] collab_read_processing_batch result', {
        spaceId,
        batchId,
        messageCount: result.messageCount,
      });

      return result;
    },
  };
}

module.exports = {
  readProcessingBatchTool,
};

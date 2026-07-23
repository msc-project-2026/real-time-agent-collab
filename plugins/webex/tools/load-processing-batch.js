// ********* LOAD_PROCESSING-BATCH.JS *********
'use strict';

const { loadProcessingBatch } = require('../batch/load');

function loadProcessingBatchTool() {
  return {
    name: 'collab_load_processing_batch',
    description:
      'Load a staged processing batch for a Webex space. Returns the normalized messages from processing/<batchId>.jsonl with additional context.',
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
      const result = await loadProcessingBatch({ spaceId, batchId });

      console.info('[webex] collab_load_processing_batch result', {
        spaceId,
        batchId,
        messageCount: result.messageCount,
      });

      return result;
    },
  };
}

module.exports = {
  loadProcessingBatchTool,
};

// ********* READ.JS *********
'use strict';

const fs = require('node:fs/promises');

const { processingBatchPath } = require('./paths.js');

async function readProcessingBatch({ spaceId, batchId, explicitRoot }) {
  if (!spaceId) throw new Error('spaceId is required');
  if (!batchId) throw new Error('batchId is required');

  try {
    const raw = await fs.readFile(
      processingBatchPath(spaceId, batchId, explicitRoot),
      'utf8'
    );

    const messages = raw
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));

    return {
      ok: true,
      spaceId,
      batchId,
      messageCount: messages.length,
      messages,
    };
  } catch (err) {
    if (err?.code === 'ENOENT') {
      throw new Error(`processing batch not found: ${spaceId}/${batchId}`);
    }
    throw err;
  }
}

module.exports = {
  readProcessingBatch,
};

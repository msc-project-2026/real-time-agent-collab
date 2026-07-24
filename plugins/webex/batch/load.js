// ********* BATCH/LOAD.JS *********
// perhaps a BATCH/store.js? and getProcessingBatch(...)?
'use strict';

const fs = require('node:fs/promises');

const { processingBatchPath } = require('../storage/paths.js');

async function loadProcessingBatch({ spaceId, batchId, explicitRoot }) {
  if (!spaceId) throw new Error('spaceId is required');
  if (!batchId) throw new Error('batchId is required');

  try {
    // Get messages
    const raw = await fs.readFile(
      processingBatchPath(spaceId, batchId, explicitRoot),
      'utf8'
    );

    const messages = raw
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));

    // Get last message
    const lastMessage = messages.at(-1);

    return {
      ok: true,
      spaceId,
      batchId,
      messageCount: messages.length,
      messages,
      suggestedReplyToId: lastMessage?.parentId ?? null,
    };
  } catch (err) {
    if (err?.code === 'ENOENT') {
      throw new Error(`processing batch not found: ${spaceId}/${batchId}`);
    }
    throw err;
  }
}

module.exports = {
  loadProcessingBatch,
};

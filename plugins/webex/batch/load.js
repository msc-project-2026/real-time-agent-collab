// ********* BATCH/LOAD.JS *********
'use strict';

const fs = require('node:fs/promises');

const { processingBatchPath } = require('../storage/paths.js');
const { readContextSummary } = require('../context/store.js');
const { read } = require('node:fs');

async function loadProcessingBatch({ spaceId, batchId, explicitRoot }) {
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

    const currentContextSummary = await readContextSummary({
      spaceId,
      explicitRoot,
    });

    const lastMessage = messages.at(-1);

    return {
      ok: true,
      spaceId,
      batchId,
      messageCount: messages.length,
      messages,
      currentContextSummary,
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

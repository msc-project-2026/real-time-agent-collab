// ********* BATCH/STAGE.JS *********
'use strict';

const fs = require('node:fs/promises');
const crypto = require('node:crypto');

const { readPendingBatchState } = require('./state.js');
const {
  pendingMessagesPath,
  pendingBatchStatePath,
  processingDir,
  processingBatchPath,
} = require('./paths.js');

async function stagePendingBatch({ spaceId, explicitRoot }) {
  if (!spaceId) throw new Error('spaceId is required');

  const state = await readPendingBatchState(spaceId, explicitRoot);

  if (!state?.messageCount) {
    return {
      ok: true,
      staged: false,
      spaceId,
      batchId: null,
      messageCount: 0,
    };
  }

  const batchId = createBatchId();

  // Rename pending/messages.jsonl to processingBatchPath()/batchId
  await fs.mkdir(processingDir(spaceId, explicitRoot), { recursive: true });

  await fs.rename(
    pendingMessagesPath(spaceId, explicitRoot),
    processingBatchPath(spaceId, batchId, explicitRoot)
  );

  // Clear pending/batch-state.json
  await fs.rm(pendingBatchStatePath(spaceId, explicitRoot), { force: true });

  // return batchId + messages
  return {
    ok: true,
    staged: true,
    spaceId,
    batchId,
    messageCount: state.messageCount,
  };
}

function createBatchId() {
  return `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto
    .randomUUID()
    .slice(0, 8)}`;
}

module.exports = {
  stagePendingBatch,
};

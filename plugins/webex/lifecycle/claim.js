// ********* CLAIM-BATCH.JS *********
'use strict';

const fs = require('node:fs/promises');
const crypto = require('node:crypto');

const {
  pendingMessagesPath,
  pendingBatchStatePath,
  processingDir,
  processingBatchPath,
} = require('./paths.js');

async function claimPendingBatch({ spaceId, explicitRoot }) {
  if (!spaceId) throw new Error('spaceId is required');

  const state = await readPendingBatchState(spaceId, explicitRoot);

  if (!state?.messageCount) {
    return {
      ok: true,
      claimed: false,
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
    claimed: true,
    spaceId,
    batchId,
    messageCount: state.messageCount,
  };
}

async function readPendingBatchState(spaceId, explicitRoot) {
  try {
    const raw = await fs.readFile(
      pendingBatchStatePath(spaceId, explicitRoot),
      'utf8'
    );

    return JSON.parse(raw);
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
}

function createBatchId() {
  return `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto
    .randomUUID()
    .slice(0, 8)}`;
}

module.exports = {
  claimPendingBatch,
};

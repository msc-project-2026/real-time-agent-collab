// ********* BATCH/STATE.JS *********
'use strict';

const fs = require('node:fs/promises');

const { pendingBatchStatePath } = require('../storage/paths');

async function readPendingBatchState(spaceId, explicitRoot) {
  if (!spaceId) throw new Error('spaceId is required');

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

module.exports = {
  readPendingBatchState,
};

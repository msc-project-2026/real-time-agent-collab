// ********* COMPLETE.JS *********
'use strict';

const fs = require('node:fs/promises');
const {
  processingBatchPath,
  processedDir,
  processedBatchPath,
  processedBatchMetaPath,
} = require('./paths');

async function completeProcessingBatch({
  spaceId,
  batchId,
  result,
  explicitRoot,
}) {
  if (!spaceId) throw new Error('spaceId is required');
  if (!batchId) throw new Error('batchId is required');

  const sourcePath = processingBatchPath(spaceId, batchId, explicitRoot);
  const targetPath = processedBatchPath(spaceId, batchId, explicitRoot);
  const metaPath = processedBatchMetaPath(spaceId, batchId, explicitRoot);

  await fs.mkdir(processedDir(spaceId, explicitRoot), { recursive: true });

  await fs.rename(sourcePath, targetPath);

  const completedAt = new Date().toISOString();

  await fs.writeFile(
    metaPath,
    JSON.stringify(
      {
        ok: true,
        spaceId,
        batchId,
        completedAt,
        result: result ?? null,
      },
      null,
      2
    ),
    'utf8'
  );

  return {
    ok: true,
    spaceId,
    batchId,
    completedAt,
    processedPath: targetPath,
  };
}

module.exports = {
  completeProcessingBatch,
};

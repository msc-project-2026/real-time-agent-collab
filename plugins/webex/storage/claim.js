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

  const messages = await readMessageBatch(spaceId, explicitRoot);
  if (!messages.length) {
    return {
      ok: true,
      claimed: false,
      spaceId,
      batchId: null,
      messageCount: 0,
      messages: [],
    };
  }

  const batchId = createBatchId();

  // Write messages to processingBatchPath()/batchId
  await fs.mkdir(processingDir(spaceId, explicitRoot), { recursive: true });

  await fs.writeFile(
    processingBatchPath(spaceId, batchId, explicitRoot),
    messages.map((m) => JSON.stringify(m)).join('\n') + '\n',
    'utf-8'
  );

  // Clear pending/messages.jsonl
  await fs.rm(pendingMessagesPath(spaceId, explicitRoot), { force: true });

  // Clear batch-state.json
  await fs.rm(pendingBatchStatePath(spaceId, explicitRoot), { force: true });

  // return batchId + messages
  return {
    ok: true,
    claimed: true,
    spaceId,
    batchId,
    messageCount: messages.length,
    messages,
  };
}

async function readMessageBatch(spaceId, explicitRoot) {
  try {
    const raw = await fs.readFile(
      pendingMessagesPath(spaceId, explicitRoot),
      'utf8'
    );

    return raw
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (err) {
    if (err?.code === 'ENOENT') return [];
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

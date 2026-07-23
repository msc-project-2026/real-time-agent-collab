// ********* BATCH/LOAD.JS *********
'use strict';

const fs = require('node:fs/promises');

const { processingBatchPath } = require('../storage/paths.js');
const { getConversations } = require('../context/conversations-store.js');

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

    // Get conversations
    const conversations = await getConversations({
      spaceId,
      explicitRoot,
      statuses: ['active', 'dormant'],
    });

    return {
      ok: true,
      spaceId,
      batchId,
      messageCount: messages.length,
      messages,
      suggestedReplyToId: lastMessage?.parentId ?? null,
      conversations,
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

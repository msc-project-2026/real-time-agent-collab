// ********* BATCH/APPEND.JS *********
'use strict';

const fs = require('node:fs/promises');
const { readPendingBatchState } = require('./state.js');

const {
  pendingDir,
  pendingMessagesPath,
  pendingBatchStatePath,
} = require('../storage/paths.js');

async function appendPendingMessage({
  spaceId,
  message,
  explicitRoot,
  debounceMs = 15000,
}) {
  if (!spaceId) throw new Error('spaceId is required');
  if (!message) throw new Error('message is required');

  const now = new Date().toISOString();

  await fs.mkdir(pendingDir(spaceId, explicitRoot), { recursive: true });

  const record = {
    ...message,
    spaceId,
    receivedAt: message.receivedAt ?? now,
  };

  await fs.appendFile(
    pendingMessagesPath(spaceId, explicitRoot),
    `${JSON.stringify(record)}\n`,
    'utf8'
  );

  const batchState = await readPendingBatchState(spaceId, explicitRoot);

  const nextState = {
    firstMessageAt: batchState?.firstMessageAt ?? record.receivedAt,
    lastMessageAt: record.receivedAt,
    messageCount: (batchState?.messageCount ?? 0) + 1,
    scheduledRunAfter: new Date(
      Date.parse(record.receivedAt) + debounceMs
    ).toISOString(),
  };

  await fs.writeFile(
    pendingBatchStatePath(spaceId, explicitRoot),
    `${JSON.stringify(nextState, null, 2)}\n`,
    'utf8'
  );

  // return result for tool/agent audit
  return {
    ok: true,
    spaceId,
    pendingMessageCount: nextState.messageCount,
    scheduledRunAfter: nextState.scheduledRunAfter,
  };
}

module.exports = {
  appendPendingMessage,
};

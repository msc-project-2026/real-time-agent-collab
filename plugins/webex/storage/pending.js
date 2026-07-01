import fs from 'node:fs/promises';

import {
  pendingDir,
  pendingMessagesPath,
  pendingBatchStatePath,
} from './paths.js';

export async function appendPendingMessage({
  spaceId,
  message,
  explicitRoot,
  debounceMs = 15000,
}) {
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

  const batchState = await readBatchState(spaceId, explicitRoot);

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

async function readBatchState(spaceId, explicitRoot) {
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

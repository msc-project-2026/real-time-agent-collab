// ********* SCHEDULE-BATCH.JS *********
'use strict';

const fs = require('node:fs/promises');
const { spacesRoot, pendingBatchStatePath } = require('../storage/paths');

// ****** Scheduler
// Note: timers are in-memory (map) only. They are lost on gateway restart/deploy.
// Recovery scanner to be added later.

const pendingBatchTimers = new Map();
const PENDING_BATCH_DEBOUNCE_MS = 30_000;

function schedulePendingBatchProcessing({
  spaceId,
  account,
  log,
  batchProcessor,
}) {
  if (!spaceId) throw new Error('spaceId is required');

  const existing = pendingBatchTimers.get(spaceId);
  if (existing) {
    clearTimeout(existing);
    log?.info?.(`[webex:${account.accountId}] pending batch timer reset`, {
      spaceId,
      debounceMs: PENDING_BATCH_DEBOUNCE_MS,
    });
  } else {
    log?.info?.(`[webex:${account.accountId}] pending batch timer scheduled`, {
      spaceId,
      debounceMs: PENDING_BATCH_DEBOUNCE_MS,
    });
  }

  const timer = setTimeout(async () => {
    pendingBatchTimers.delete(spaceId);

    log?.info?.(`[webex:${account.accountId}] pending batch timer fired`, {
      spaceId,
    });

    try {
      await batchProcessor({
        spaceId,
        account,
        log,
      });

      log?.info?.(
        `[webex:${account.accountId}] pending batch trigger completed`,
        {
          spaceId,
        }
      );
    } catch {
      log?.error?.(
        `[webex:${account.accountId}] pending batch trigger failed: ${err?.message ?? err}`
      );
    }
  }, PENDING_BATCH_DEBOUNCE_MS);

  pendingBatchTimers.set(spaceId, timer);
}

// ****** On-restart Scan
//

async function scanOverduePendingBatches({ account, log, batchProcessor }) {
  const root = spacesRoot();

  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (err) {
    if (err?.code === 'ENOENT') return;
  }

  const now = Date.now();

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    // Valid assumption that safeSegment(spaceId) at write time is identical to spaceId
    const spacedId = entry.name;
    const statePath = pendingBatchStatePath(spacedId);

    let state;
    try {
      state = JSON.parse(await fs.readFile(statePath, 'utf8'));
    } catch (err) {
      if (err?.code === 'ENOENT') continue;
      log?.warn?.(
        `[webex:${account.accountId}] failed to read pending batch state`,
        {
          spaceId,
          error: err?.message ?? String(err),
        }
      );
      continue;
    }

    if (!state.scheduledRunAfter) continue;

    if (new Date(state.scheduledRunAfter).getTime() <= now) {
      log?.info?.(`[webex:${account.accountId}] overdue pending batch found`, {
        spaceId,
        scheduledRunAfter: state.scheduledRunAfter,
      });

      await batchProcessor({ spaceId, account, log });
    }
  }
}

module.exports = {
  schedulePendingBatchProcessing,
  scanOverduePendingBatches,
};

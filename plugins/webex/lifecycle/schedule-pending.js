// ********* SCHEDULE-PENDING.JS *********
'use strict';

const fs = require('node:fs/promises');
const { spacesRoot, pendingBatchStatePath } = require('./paths');

// *** Scheduler
// Note: timers are in-memory (map) only. They are lost on gateway restart/deploy.
// Recovery scanner to be added later.

const pendingBatchTimers = new Map();
const PENDING_BATCH_DEBOUNCE_MS = 30_000;

function schedulePendingBatchStaging({
  spaceId,
  account,
  log,
  batchStagingHandler,
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
      await batchStagingHandler({
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

// *** On-restart Scan
async function scanPendingBatchStaging({ account, log, batchStagingHandler }) {
  const root = spacesRoot();

  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (err) {
    if (err?.code === 'ENOENT') return;
    throw err;
  }

  const now = Date.now();

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    // Valid assumption that safeSegment(spaceId) at write time is identical to spaceId
    const spaceId = entry.name;
    const statePath = pendingBatchStatePath(spaceId);

    let state;
    try {
      state = JSON.parse(await fs.readFile(statePath, 'utf8'));
    } catch (err) {
      if (err?.code === 'ENOENT') {
        log?.warn?.(
          `[webex:${account.accountId}] failed to read pending batch state`,
          {
            spaceId,
            error: err?.message ?? String(err),
          }
        );
      }
      continue;
    }

    const scheduledAt = new Date(state.scheduledRunAfter).getTime();

    if (!Number.isFinite(scheduledAt)) {
      log?.warn?.(`[webex:${account.accountId}] invalid scheduledRunAfter`, {
        spaceId,
        scheduledRunAfter: state.scheduledRunAfter,
      });
      continue;
    }

    if (scheduledAt <= now) {
      log?.info?.(`[webex:${account.accountId}] overdue pending batch found`, {
        spaceId,
        scheduledRunAfter: state.scheduledRunAfter,
        messageCount: state.messageCount,
      });

      try {
        await batchStagingHandler({ spaceId, account, log });
      } catch (err) {
        log?.error?.(
          `[webex:${account.accountId}] failed to recover pending batch ${JSON.stringify(
            {
              spaceId,
              error: err?.message ?? String(err),
              stack: err?.stack ?? null,
            }
          )}`
        );

        continue;
      }
    }
  }
}

// *** Run Scan
async function runPendingBatchStagingRecovery({
  account,
  log,
  batchStagingHandler,
}) {
  const accountId = account?.accountId ?? 'default';

  log?.info?.(`[webex:${accountId}] running pending recovery batch scan`);

  try {
    await scanPendingBatchStaging({
      account,
      log,
      batchStagingHandler,
    });

    log?.info?.(`[webex:${accountId}] pending batch scan recovery completed`);
  } catch (err) {
    log?.error?.(
      `[webex:${accountId}] pending batch recovery scan failed: ${err?.message ?? err}`
    );
  }
}

module.exports = {
  schedulePendingBatchStaging,
  runPendingBatchStagingRecovery,
};

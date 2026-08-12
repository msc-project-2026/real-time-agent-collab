'use strict';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffDelay(attempt, maxMs) {
  const base = 300 * 2 ** (attempt - 1);
  return Math.min(base + Math.random() * base * 0.5, maxMs);
}

function isSessionInitConflict(err) {
  return /session initialization conflicted/i.test(err?.message ?? '');
}

// Keep this helper inside the plugin so the folder can be copied to another
// OpenClaw instance without also copying the repository-level lib directory.
async function dispatchWithSessionRecovery(
  dispatch,
  buildArgs,
  { retry = {}, onRecovery, settleDelayMs = 500 } = {}
) {
  const { maxAttempts = 4, maxBackoffMs = 1000 } = retry;
  try {
    const args = buildArgs();
    for (let attempt = 1; ; attempt++) {
      try {
        return await dispatch(args);
      } catch (err) {
        if (!isSessionInitConflict(err) || attempt === maxAttempts) throw err;
        await sleep(backoffDelay(attempt, maxBackoffMs));
      }
    }
  } catch (err) {
    if (!isSessionInitConflict(err)) throw err;
    const recoverySuffix = `recovery-${Date.now()}`;
    onRecovery?.(recoverySuffix, err);
    await sleep(settleDelayMs);
    return dispatch(buildArgs(recoverySuffix));
  }
}

module.exports = { dispatchWithSessionRecovery };

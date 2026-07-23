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

// Dispatches under the canonical session key, retrying transient OpenClaw
// session-init conflicts, then falls back to one dispatch under a throwaway
// recovery session key. A conflict that survives the same-key retries is not
// the transient busy-session race: the gateway's init check for that key is
// wedged and cannot succeed until a process restart, while a fresh key has
// nothing to conflict with — so the message is answered instead of dropped.
//
// The defaults keep the whole recovery window under ~3 s: worst case is
// ~2.35 s of same-key backoff (450 ms + 900 ms + 1 s with full jitter) plus
// the 500 ms settle before the recovery dispatch. A recovery turn starts a
// blank OpenClaw session; conversational context must come from elsewhere
// (local collab files), not the session transcript.
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
    return await dispatch(buildArgs(recoverySuffix));
  }
}

module.exports = { dispatchWithSessionRecovery };

'use strict';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffDelay(attempt, maxMs = 15000) {
  const base = 300 * 2 ** (attempt - 1);
  return Math.min(base + Math.random() * base * 0.5, maxMs);
}

// Session conflicts happen when OpenClaw's internal session hasn't fully
// cleaned up yet after a previous long-running dispatch (LLM + tool calls
// can run for 60–120 s). The default 5 attempts / 5 s ceiling isn't enough
// to survive that cleanup window; raise both so queued messages are not
// silently dropped after a busy session.
async function dispatchWithRetry(dispatch, args, { maxAttempts = 12, maxBackoffMs = 15000 } = {}) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await dispatch(args);
    } catch (err) {
      const isSessionConflict = /session initialization conflicted/i.test(err?.message ?? '');
      if (!isSessionConflict || attempt === maxAttempts) throw err;
      await sleep(backoffDelay(attempt, maxBackoffMs));
    }
  }
}

module.exports = { dispatchWithRetry };
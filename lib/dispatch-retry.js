'use strict';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffDelay(attempt) {
  const base = 300 * 2 ** (attempt - 1);
  return Math.min(base + Math.random() * base * 0.5, 5000);
}

async function dispatchWithRetry(dispatch, args, { maxAttempts = 5 } = {}) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await dispatch(args);
    } catch (err) {
      const isSessionConflict = /session initialization conflicted/i.test(err?.message ?? '');
      if (!isSessionConflict || attempt === maxAttempts) throw err;
      await sleep(backoffDelay(attempt));
    }
  }
}

module.exports = { dispatchWithRetry };
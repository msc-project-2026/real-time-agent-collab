// Per-session FIFO coordination for OpenClaw dispatches.
"use strict";

const dispatchQueues = new Map();

/**
 * Run a dispatch after all earlier dispatches for the same session have
 * settled. Different sessions are never made to wait for one another.
 *
 * OpenClaw session initialization is not safe to run concurrently for the
 * same SessionKey. Keeping the coordination here also preserves message order
 * within a Webex room without adding a timer to the uncontended path.
 */
function enqueueSessionDispatch(sessionKey, dispatchJob) {
  const previous = dispatchQueues.get(sessionKey) ?? Promise.resolve();
  const result = previous.catch(() => undefined).then(dispatchJob);
  const tracked = result.finally(() => {
    if (dispatchQueues.get(sessionKey) === tracked) {
      dispatchQueues.delete(sessionKey);
    }
  });

  dispatchQueues.set(sessionKey, tracked);
  return tracked;
}

module.exports = { enqueueSessionDispatch };

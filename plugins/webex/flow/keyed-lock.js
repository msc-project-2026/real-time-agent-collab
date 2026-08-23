// ********* FLOW/KEYED-LOCK.JS *********
'use strict';

// Generic in-process serialization primitive — a Map<key, Promise> chain.
// Reused across the plugin wherever two async operations that touch the same
// keyed resource must not interleave: per-thread gate+flush, per-space
// extraction, per-space store writes (see storage/threads-store.js,
// storage/tasks-store.js, flow/run-message-flow.js). Valid because the
// Gateway is a single process — no cross-process coordination needed.
//
// Was previously duplicated ad hoc as `taggingQueues`/`enqueueTaggingDispatch`
// in gate/dispatch.js (phase 3) for exactly the per-thread-gate case; that
// call site now uses this shared module instead, widened to also cover the
// flush that follows the gate decision (see run-message-flow.js).

const chains = new Map();

// Runs `fn` after whatever's already queued for `key` settles (success or
// failure) — a rejected `fn` never wedges the queue for the next caller on
// the same key. Independent keys never block each other.
function withLock(key, fn) {
  const prior = chains.get(key) ?? Promise.resolve();

  const next = prior.then(fn, fn);

  // Tracked only for chaining, not observed here — the caller awaits `next`
  // directly for the real result/error.
  const settled = next.catch(() => {});
  chains.set(key, settled);

  settled.finally(() => {
    if (chains.get(key) === settled) {
      chains.delete(key);
    }
  });

  return next;
}

module.exports = {
  withLock,
};

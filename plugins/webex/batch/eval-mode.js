// ********* BATCH/EVAL-MODE.JS *********
'use strict';

// Shared flag set by the eval runner to suppress automatic batch staging.
// When active, both schedulePendingBatchStaging (deferred timer) and the
// immediate task_request staging path in handleRouteResult are suppressed.
// Messages still accumulate in pending batches normally via appendPendingMessage.
// The eval runner triggers staging explicitly at each round boundary instead.

let active = false;

function setEvalMode(on) {
  active = !!on;
}

function isEvalMode() {
  return active;
}

module.exports = { setEvalMode, isEvalMode };

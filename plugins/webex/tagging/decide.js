// ********* TAGGING/DECIDE.JS *********
'use strict';

// v3 §5 dispatch — deterministic code, not a model decision. Reads the tagging
// gate's tool-call output (v3 §4) plus the deterministic `botIsMentioned` flag
// and decides what happens next. No I/O, no side effects — pure controller
// logic so it's unit-testable independent of the LLM (phase 3).

function decideDispatch({ tagResult, botIsMentioned }) {
  const messageTags = tagResult?.messageTags ?? {};
  const windowDecision = tagResult?.pendingThreadWindowDecision ?? {};

  const finalIsMentioned = Boolean(botIsMentioned) || Boolean(messageTags.isMentioned);
  const configRequest = Boolean(messageTags.configRequest);
  const ready = Boolean(windowDecision.ready);

  return {
    finalIsMentioned,
    configRequest,
    ready,
    // Mention or ready both flush the pending slice and spawn processing —
    // independent of configRequest, and independent of each other (either or
    // both can be true for the same message).
    shouldProcess: finalIsMentioned || ready,
    reason: windowDecision.reason ?? null,
  };
}

module.exports = {
  decideDispatch,
};

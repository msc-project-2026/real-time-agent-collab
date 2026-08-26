// ********* PROCESSING/GATE/DECIDE.JS *********
'use strict';

// v3 §5 dispatch — deterministic code, not a model decision. Reads the tagging
// gate's tool-call output (v3 §4) plus the deterministic `isBotMentioned` flag
// and decides what happens next. No I/O, no side effects — pure controller
// logic so it's unit-testable independent of the LLM (phase 3).
//
// Two distinct addressing signals stay visible on the return value rather
// than being collapsed into one: `isBotMentioned` (deterministic, a literal
// Webex @-mention) and `isBotAddressed` (the gate's own semantic judgment).
// `shouldRespond` is the derived OR of the two — the one point where naming
// crosses from platform-specific ("Bot") to generic, since it's what
// actually gates the pipeline-level decision to spawn `respond` at all, not
// a Webex-specific fact anymore.

function decideDispatch({ tagResult, isBotMentioned }) {
  const messageTags = tagResult?.messageTags ?? {};
  const windowDecision = tagResult?.pendingThreadWindowDecision ?? {};

  const finalIsBotMentioned = Boolean(isBotMentioned);
  const isBotAddressed = Boolean(messageTags.isAddressed);
  const configRequest = Boolean(messageTags.configRequest);
  const sliceReady = Boolean(windowDecision.sliceReady);
  const shouldRespond = finalIsBotMentioned || isBotAddressed;

  return {
    isBotMentioned: finalIsBotMentioned,
    isBotAddressed,
    shouldRespond,
    configRequest,
    sliceReady,
    // Mention/addressed or sliceReady both flush the pending slice and spawn
    // extract/summarize — independent of configRequest, and independent of
    // each other (either or both can be true for the same message).
    // `respond` itself only spawns on `shouldRespond` (see run-message-flow.js).
    shouldProcess: shouldRespond || sliceReady,
    reason: windowDecision.reason ?? null,
  };
}

module.exports = {
  decideDispatch,
};

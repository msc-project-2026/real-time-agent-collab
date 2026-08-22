// ********* TAGGING/VALIDATION-LOG.JS *********
'use strict';

const fs = require('node:fs/promises');

const { taggingDir, taggingValidationLogPath } = require('../storage/paths');

// Appends one shadow-mode record per completed gate run, for manually
// comparing the gate's output-quality against the existing routing pipeline
// it runs alongside (phase 2 — the gate does not control dispatch yet).
async function appendTaggingValidationRecord({
  spaceId,
  threadKey,
  messageId,
  runId,
  pendingSliceSize,
  toolCallAttempts,
  tagResult,
  explicitRoot,
}) {
  if (!spaceId) throw new Error('spaceId is required');
  if (!threadKey) throw new Error('threadKey is required');

  const record = {
    at: new Date().toISOString(),
    spaceId,
    threadKey,
    messageId: messageId ?? null,
    runId: runId ?? null,
    pendingSliceSize: pendingSliceSize ?? null,
    // How many tag_message attempts the gate itself reported making this
    // turn (self-reported, diagnostic only) — see tagging/instruction.js.
    toolCallAttempts: toolCallAttempts ?? null,
    messageTags: tagResult?.messageTags ?? null,
    pendingThreadWindowDecision: tagResult?.pendingThreadWindowDecision ?? null,
  };

  await fs.mkdir(taggingDir(spaceId, explicitRoot), { recursive: true });
  await fs.appendFile(
    taggingValidationLogPath(spaceId, explicitRoot),
    `${JSON.stringify(record)}\n`,
    'utf8'
  );

  return record;
}

module.exports = {
  appendTaggingValidationRecord,
};

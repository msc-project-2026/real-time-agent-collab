// ********* PATHS.JS *********
'use strict';

const path = require('node:path');
const { getHeapSpaceStatistics } = require('node:v8');

const ROOT = '.collab';
const DEFAULT_WORKSPACE_ROOT = '/home/node/.openclaw/workspace';

// Helpers

function getWorkspaceRoot(explicitRoot) {
  return (
    explicitRoot ?? process.env.OPENCLAW_WORKSPACE_DIR ?? DEFAULT_WORKSPACE_ROOT
  );
}

function safeSegment(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]/g, '_');
}

// Paths

// -- .collab/space(s)
function spaceRoot(spaceId, explicitRoot) {
  const workspaceRoot = getWorkspaceRoot(explicitRoot);
  return path.join(workspaceRoot, ROOT, 'spaces', safeSegment(spaceId));
}

function spacesRoot(explicitRoot) {
  const workspaceRoot = getWorkspaceRoot(explicitRoot);
  return path.join(workspaceRoot, ROOT, 'spaces');
}

// -- ./pending/
function pendingDir(spaceId, explicitRoot) {
  return path.join(spaceRoot(spaceId, explicitRoot), 'pending');
}

function pendingMessagesPath(spaceId, explicitRoot) {
  return path.join(pendingDir(spaceId, explicitRoot), 'messages.jsonl');
}

function pendingBatchStatePath(spaceId, explicitRoot) {
  return path.join(pendingDir(spaceId, explicitRoot), 'batch-state.json');
}

// -- ./processing/
function processingDir(spaceId, explicitRoot) {
  return path.join(spaceRoot(spaceId, explicitRoot), 'processing');
}

function processingBatchPath(spaceId, batchId, explicitRoot) {
  return path.join(processingDir(spaceId, explicitRoot), `${batchId}.jsonl`);
}

// -- ./processed/
function processedDir(spaceId, explicitRoot) {
  return path.join(spaceRoot(spaceId, explicitRoot), 'processed');
}

function processedBatchPath(spaceId, batchId, explicitRoot) {
  return path.join(processedDir(spaceId, explicitRoot), `${batchId}.jsonl`);
}

function processedBatchMetaPath(spaceId, batchId, explicitRoot) {
  return path.join(processedDir(spaceId, explicitRoot), `${batchId}.meta.json`);
}

module.exports = {
  getWorkspaceRoot,
  spaceRoot,
  spacesRoot,
  pendingDir,
  pendingMessagesPath,
  pendingBatchStatePath,
  processingDir,
  processingBatchPath,
  processedDir,
  processedBatchPath,
  processedBatchMetaPath,
};

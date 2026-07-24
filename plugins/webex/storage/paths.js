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

// -- .collab/spaces/
function spacesRoot(explicitRoot) {
  const workspaceRoot = getWorkspaceRoot(explicitRoot);
  return path.join(workspaceRoot, ROOT, 'spaces');
}

// -- .collab/spaces/<spaceId>/
function spaceDir(spaceId, explicitRoot) {
  const workspaceRoot = getWorkspaceRoot(explicitRoot);
  return path.join(spacesRoot(explicitRoot), safeSegment(spaceId));
}

// -- .collab/spaces/<spaceId>/pending/
function pendingDir(spaceId, explicitRoot) {
  return path.join(spaceDir(spaceId, explicitRoot), 'pending');
}

function pendingMessagesPath(spaceId, explicitRoot) {
  return path.join(pendingDir(spaceId, explicitRoot), 'messages.jsonl');
}

function pendingBatchStatePath(spaceId, explicitRoot) {
  return path.join(pendingDir(spaceId, explicitRoot), 'batch-state.json');
}

// -- .collab/spaces/<spaceId>/processing/
function processingDir(spaceId, explicitRoot) {
  return path.join(spaceDir(spaceId, explicitRoot), 'processing');
}

function processingBatchPath(spaceId, batchId, explicitRoot) {
  return path.join(processingDir(spaceId, explicitRoot), `${batchId}.jsonl`);
}

// -- .collab/spaces/<spaceId>/processed/
function processedDir(spaceId, explicitRoot) {
  return path.join(spaceDir(spaceId, explicitRoot), 'processed');
}

function processedBatchPath(spaceId, batchId, explicitRoot) {
  return path.join(processedDir(spaceId, explicitRoot), `${batchId}.jsonl`);
}

function processedBatchMetaPath(spaceId, batchId, explicitRoot) {
  return path.join(processedDir(spaceId, explicitRoot), `${batchId}.meta.json`);
}

// -- .collab/spaces/<spaceId>/config/
function configDir(spaceId, explicitRoot) {
  return path.join(spaceDir(spaceId, explicitRoot), 'config');
}

function activeConfigPath(spaceId, explicitRoot) {
  return path.join(configDir(spaceId, explicitRoot), 'active.json');
}

// -- .collab/spaces/<spaceId>/context/
function contextDir(spaceId, explicitRoot) {
  return path.join(spaceDir(spaceId, explicitRoot), 'context');
}

function conversationsPath(spaceId, explicitRoot) {
  return path.join(contextDir(spaceId, explicitRoot), 'conversations.json');
}

function itemsPath(spaceId, explicitRoot) {
  return path.join(contextDir(spaceId, explicitRoot), 'items.json');
}

module.exports = {
  getWorkspaceRoot,
  spacesRoot,
  spaceDir,
  pendingDir,
  pendingMessagesPath,
  pendingBatchStatePath,
  processingDir,
  processingBatchPath,
  processedDir,
  processedBatchPath,
  processedBatchMetaPath,
  configDir,
  activeConfigPath,
  contextDir,
  conversationsPath,
  itemsPath,
};

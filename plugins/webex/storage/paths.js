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

function threadsPath(spaceId, explicitRoot) {
  return path.join(contextDir(spaceId, explicitRoot), 'threads.json');
}

// v3 §7c task schema (phase 6) — one file per space, same pattern as
// threads.json (not one file per thread; tasks aren't thread-scoped).
function tasksPath(spaceId, explicitRoot) {
  return path.join(contextDir(spaceId, explicitRoot), 'tasks.json');
}

// Reverse child->parent index, same pattern as the §9 supersession index —
// parent_tasks is never stored on the task record itself (context/tasks-store.js).
function taskParentIndexPath(spaceId, explicitRoot) {
  return path.join(contextDir(spaceId, explicitRoot), 'task-parents.json');
}

// v3 §9 recall/vector index (phase 7) — one index per space, same
// per-space (not per-thread) convention as tasks.json/threads.json.
function recallIndexPath(spaceId, explicitRoot) {
  return path.join(contextDir(spaceId, explicitRoot), 'recall-index.json');
}

// Reverse old->new supersession lookup, same pattern as task-parents.json —
// a recall entry's `supersedes` relationship is never mutated onto the old
// entry itself (v3 §9: "Never mutate the old entry").
function recallSupersessionIndexPath(spaceId, explicitRoot) {
  return path.join(contextDir(spaceId, explicitRoot), 'recall-supersession.json');
}

// -- .collab/spaces/<spaceId>/tagging/
function taggingDir(spaceId, explicitRoot) {
  return path.join(spaceDir(spaceId, explicitRoot), 'tagging');
}

// Shadow-mode output-quality log for the v3 §4 tagging gate (phase 2) — not
// read by any pipeline code, only appended to for manual/offline comparison
// against the existing routing pipeline it runs alongside.
function taggingValidationLogPath(spaceId, explicitRoot) {
  return path.join(taggingDir(spaceId, explicitRoot), 'validation.jsonl');
}

// -- .collab/spaces/<spaceId>/jobs/
// Phase 5 step-level audit trail (one line per flow step attempt), keyed by
// flowId — the actual eval-grade record of what each step did, since Task
// Flow's own task-level tracking (runTask) is not used (see v3 migration
// memory: unreliable for this plugin's runEmbeddedAgent-based spawns).
function jobsDir(spaceId, explicitRoot) {
  return path.join(spaceDir(spaceId, explicitRoot), 'jobs');
}

function jobLogPath(spaceId, flowId, explicitRoot) {
  return path.join(jobsDir(spaceId, explicitRoot), `${safeSegment(flowId)}.jsonl`);
}

module.exports = {
  getWorkspaceRoot,
  safeSegment,
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
  threadsPath,
  tasksPath,
  taskParentIndexPath,
  recallIndexPath,
  recallSupersessionIndexPath,
  taggingDir,
  taggingValidationLogPath,
  jobsDir,
  jobLogPath,
};

// ********* STORAGE/TASKS-STORE.JS *********
'use strict';

// v3 §7c task schema (phase 6) — replaces context/items-store.js's free-form
// item schema. One file per space (tasksPath(spaceId)), same layout pattern
// as threads.json — tasks aren't thread-scoped, so every task for every
// thread in a space lives in one flat list here.

const fs = require('node:fs/promises');
const crypto = require('node:crypto');

const { contextDir, tasksPath, taskParentIndexPath } = require('./paths');
const { writeJsonFileAtomic } = require('./atomic-write');

// ** Task shape ** {
//   schemaVersion: 1,
//   id: 'task_...',
//   title: string,                   // short human-readable summary — required.
//                                     // Corrects a v3 §7c doc gap: a task with no
//                                     // rendering beyond type/status/assignee isn't
//                                     // actually reviewable by a person.
//   description: string,             // optional longer elaboration.
//   type: string,                    // development | design | research | ... — open
//                                     // taxonomy; validated against a starter
//                                     // allowlist at the tool layer (write_task),
//                                     // not here.
//   assigned: 'unknown' | string,    // member/sender id
//   deadline: 'unknown' | string,    // ISO datetime
//   status: 'unapproved' | 'backlog' | 'in_progress' | 'in_review' | 'done' | 'archived',
//   confidence: null | number,       // 0-1, only meaningful when assigned === 'agent'
//                                     // — the extraction model's own estimate that a
//                                     // self-assigned task is genuinely warranted.
//                                     // Drives the auto-approval override (write_task,
//                                     // response-policy + extraction-calibration
//                                     // revision) — see CONFIDENCE_AUTO_APPROVE_THRESHOLD.
//   delegation: null | { target: string, delegatedAt: string },
//                                     // set only by the auto-approval override when
//                                     // confidence clears the threshold — a real,
//                                     // backend-owned field, distinct from the board's
//                                     // own manual delegate button (still local-only,
//                                     // unrelated mechanism, see board/src/App.jsx).
//   message_ids: [...],              // direct evidence only, never via a
//                                     // conversation hop — append-only.
//   child_tasks: [...],              // single direction, cycle-checked on
//                                     // write (wouldCreateCycle) — append-only.
//   createdAt, updatedAt,
// }
// parent_tasks is NEVER stored on the task record — derived by reverse
// lookup (getParentTasks) from a separate index file, same non-mutation
// principle as the v3 §9 summary-supersession index.
//
// Board-workflow revision: `delegated` is no longer a status value here —
// the board's own manual delegation action stays board-local UI state only
// (board/src/App.jsx), not persisted. `delegation` above is a separate,
// later-added mechanism: our own pipeline code setting it automatically via
// the confidence auto-approval override, not the board's manual button.

const ACTIVE_STATUSES = new Set(['unapproved', 'backlog', 'in_progress', 'in_review', 'done']);

// Auto-approval bar for a self-assigned (assigned: 'agent') task's
// extraction-time confidence score — see write_task's override logic
// (processing/extract/tool.js). Tunable later.
const CONFIDENCE_AUTO_APPROVE_THRESHOLD = 0.7;

function defaultTasksState() {
  return {
    schemaVersion: 1,
    tasks: [],
    updatedAt: null,
  };
}

function defaultTaskParentIndexState() {
  return {
    schemaVersion: 1,
    rows: [], // { childId, parentId }
  };
}

function generateTaskId() {
  return `task_${crypto.randomBytes(8).toString('hex')}`;
}

// Read/write

async function readTasksState({ spaceId, explicitRoot } = {}) {
  if (!spaceId) throw new Error('spaceId is required');

  try {
    return JSON.parse(
      await fs.readFile(tasksPath(spaceId, explicitRoot), 'utf8')
    );
  } catch (err) {
    if (err?.code === 'ENOENT') return defaultTasksState();
    throw err;
  }
}

async function writeTasksState({ spaceId, state, explicitRoot }) {
  if (!spaceId) throw new Error('spaceId is required');
  if (!state || typeof state !== 'object') {
    throw new Error('state object is required');
  }

  const defaults = defaultTasksState();

  const record = {
    schemaVersion: state.schemaVersion ?? defaults.schemaVersion,
    tasks: Array.isArray(state.tasks) ? state.tasks : defaults.tasks,
    updatedAt: state.updatedAt ?? new Date().toISOString(),
  };

  await fs.mkdir(contextDir(spaceId, explicitRoot), { recursive: true });
  await writeJsonFileAtomic(tasksPath(spaceId, explicitRoot), record);

  return record;
}

async function readTaskParentIndex({ spaceId, explicitRoot } = {}) {
  if (!spaceId) throw new Error('spaceId is required');

  try {
    return JSON.parse(
      await fs.readFile(taskParentIndexPath(spaceId, explicitRoot), 'utf8')
    );
  } catch (err) {
    if (err?.code === 'ENOENT') return defaultTaskParentIndexState();
    throw err;
  }
}

async function writeTaskParentIndex({ spaceId, state, explicitRoot }) {
  if (!spaceId) throw new Error('spaceId is required');

  const defaults = defaultTaskParentIndexState();
  const record = {
    schemaVersion: state?.schemaVersion ?? defaults.schemaVersion,
    rows: Array.isArray(state?.rows) ? state.rows : defaults.rows,
  };

  await fs.mkdir(contextDir(spaceId, explicitRoot), { recursive: true });
  await writeJsonFileAtomic(taskParentIndexPath(spaceId, explicitRoot), record);

  return record;
}

// Parent/ancestor lookups

// Immediate parents of `childId` — what `parent_tasks` would show at read
// time, derived, never stored on the task record itself.
async function getParentTasks(childId, { spaceId, explicitRoot } = {}) {
  if (!spaceId) throw new Error('spaceId is required');
  if (!childId) throw new Error('childId is required');

  const index = await readTaskParentIndex({ spaceId, explicitRoot });
  return index.rows
    .filter((row) => row.childId === childId)
    .map((row) => row.parentId);
}

async function getAncestorIds({ spaceId, taskId, explicitRoot, index }) {
  const parentIndex = index ?? (await readTaskParentIndex({ spaceId, explicitRoot }));

  const parentsOf = new Map();
  for (const row of parentIndex.rows) {
    if (!parentsOf.has(row.childId)) parentsOf.set(row.childId, []);
    parentsOf.get(row.childId).push(row.parentId);
  }

  const ancestors = new Set();
  const stack = [...(parentsOf.get(taskId) ?? [])];

  while (stack.length > 0) {
    const current = stack.pop();
    if (ancestors.has(current)) continue;
    ancestors.add(current);
    stack.push(...(parentsOf.get(current) ?? []));
  }

  return ancestors;
}

// Would setting parentId.child_tasks += childId create a cycle? True for a
// self-reference, or if childId is already an ancestor of parentId (i.e.
// childId -> ... -> parentId already exists, so parentId -> childId would
// close the loop).
async function wouldCreateCycle({ spaceId, parentId, childId, explicitRoot }) {
  if (!spaceId) throw new Error('spaceId is required');
  if (!parentId) throw new Error('parentId is required');
  if (!childId) throw new Error('childId is required');

  if (parentId === childId) return true;

  const ancestors = await getAncestorIds({ spaceId, taskId: parentId, explicitRoot });
  return ancestors.has(childId);
}

// Upsert

// Single upsert entry point (backs the write_task tool, a later phase):
// no `id` -> create; `id` present -> patch an existing task. Only fields
// actually passed in `patch` change. `message_ids`/`child_tasks` are
// append-only (evidence/edges accumulate, never get silently dropped).
// `child_tasks` additions are cycle-checked here — rejecting a cycle throws,
// the caller decides how to surface that (tool layer, later phase).
async function upsertTask({ spaceId, id, patch = {}, explicitRoot }) {
  if (!spaceId) throw new Error('spaceId is required');
  if (!patch || typeof patch !== 'object') {
    throw new Error('patch object is required');
  }

  const state = await readTasksState({ spaceId, explicitRoot });
  const tasks = Array.isArray(state.tasks) ? state.tasks : [];

  const now = new Date().toISOString();
  const existingIndex = id ? tasks.findIndex((task) => task.id === id) : -1;

  if (id && existingIndex === -1) {
    throw new Error(`task not found: ${id}`);
  }

  let task;

  if (existingIndex === -1) {
    if (!patch.type) throw new Error('`type` is required to create a task');
    if (!patch.title) throw new Error('`title` is required to create a task');

    task = {
      schemaVersion: 1,
      id: generateTaskId(),
      title: patch.title,
      description: patch.description ?? '',
      type: patch.type,
      assigned: patch.assigned ?? 'unknown',
      deadline: patch.deadline ?? 'unknown',
      status: patch.status ?? 'unapproved',
      confidence: patch.confidence ?? null,
      delegation: patch.delegation ?? null,
      message_ids: [],
      child_tasks: [],
      createdAt: now,
      updatedAt: now,
    };
  } else {
    const existing = tasks[existingIndex];
    task = {
      ...existing,
      title: patch.title ?? existing.title,
      description: patch.description ?? existing.description,
      type: patch.type ?? existing.type,
      assigned: patch.assigned ?? existing.assigned,
      deadline: patch.deadline ?? existing.deadline,
      status: patch.status ?? existing.status,
      confidence: patch.confidence ?? existing.confidence ?? null,
      delegation: patch.delegation ?? existing.delegation ?? null,
      updatedAt: now,
    };
  }

  if (Array.isArray(patch.message_ids) && patch.message_ids.length > 0) {
    const existingIds = new Set(task.message_ids);
    task.message_ids = [
      ...task.message_ids,
      ...patch.message_ids.filter((messageId) => !existingIds.has(messageId)),
    ];
  }

  let parentIndex = null;

  if (Array.isArray(patch.child_tasks) && patch.child_tasks.length > 0) {
    parentIndex = await readTaskParentIndex({ spaceId, explicitRoot });

    const existingChildren = new Set(task.child_tasks);
    const newChildRows = [];

    for (const childId of patch.child_tasks) {
      if (existingChildren.has(childId)) continue;

      if (task.id === childId) {
        throw new Error(`self-referential child_tasks rejected: ${task.id}`);
      }

      const ancestors = await getAncestorIds({
        spaceId,
        taskId: task.id,
        explicitRoot,
        index: parentIndex,
      });
      if (ancestors.has(childId)) {
        throw new Error(
          `child_tasks write rejected: ${childId} is already an ancestor of ${task.id} (would create a cycle)`
        );
      }

      existingChildren.add(childId);
      newChildRows.push({ childId, parentId: task.id });
    }

    task.child_tasks = [...task.child_tasks, ...newChildRows.map((row) => row.childId)];

    if (newChildRows.length > 0) {
      parentIndex = {
        ...parentIndex,
        rows: [...parentIndex.rows, ...newChildRows],
      };
    }
  }

  const newTasks =
    existingIndex === -1
      ? [...tasks, task]
      : tasks.map((existing, index) => (index === existingIndex ? task : existing));

  await writeTasksState({
    spaceId,
    state: { ...state, tasks: newTasks },
    explicitRoot,
  });

  if (parentIndex) {
    await writeTaskParentIndex({ spaceId, state: parentIndex, explicitRoot });
  }

  return task;
}

// Queries

// Bulk-injected set for extract/respond — everything except archived. `done`
// stays in (still matters as "what did we already finish" context); only
// `archived` drops out.
async function getActiveTasks({ spaceId, explicitRoot, limit = 100 } = {}) {
  if (!spaceId) throw new Error('spaceId is required');

  const state = await readTasksState({ spaceId, explicitRoot });
  const tasks = Array.isArray(state.tasks) ? state.tasks : [];

  return tasks
    .filter((task) => ACTIVE_STATUSES.has(task.status))
    .sort((a, b) => new Date(b.updatedAt ?? 0).getTime() - new Date(a.updatedAt ?? 0).getTime())
    .slice(0, limit);
}

async function getTasks({
  spaceId,
  explicitRoot,
  statuses,
  types,
  messageIds,
  limit = 100,
} = {}) {
  if (!spaceId) throw new Error('spaceId is required');

  const state = await readTasksState({ spaceId, explicitRoot });
  let tasks = Array.isArray(state.tasks) ? state.tasks : [];

  if (Array.isArray(statuses) && statuses.length > 0) {
    const allowed = new Set(statuses);
    tasks = tasks.filter((task) => allowed.has(task.status));
  }

  if (Array.isArray(types) && types.length > 0) {
    const allowed = new Set(types);
    tasks = tasks.filter((task) => allowed.has(task.type));
  }

  if (Array.isArray(messageIds) && messageIds.length > 0) {
    const wanted = new Set(messageIds);
    tasks = tasks.filter(
      (task) =>
        Array.isArray(task.message_ids) &&
        task.message_ids.some((messageId) => wanted.has(messageId))
    );
  }

  return tasks
    .slice()
    .sort((a, b) => new Date(b.updatedAt ?? 0).getTime() - new Date(a.updatedAt ?? 0).getTime())
    .slice(0, limit);
}

// Backing function for the search_tasks tool (later phase). Plain
// lowercase-substring scan over tasks.json — deliberately not a dedicated
// search index; see plan scope decision 3.
async function searchTasks({ spaceId, explicitRoot, query, includeArchived = true, limit = 20 } = {}) {
  if (!spaceId) throw new Error('spaceId is required');
  if (!query || typeof query !== 'string' || !query.trim()) {
    throw new Error('query is required');
  }

  const state = await readTasksState({ spaceId, explicitRoot });
  let tasks = Array.isArray(state.tasks) ? state.tasks : [];

  if (!includeArchived) {
    tasks = tasks.filter((task) => task.status !== 'archived');
  }

  const needle = query.trim().toLowerCase();

  return tasks
    .filter((task) => {
      const haystack = [task.id, task.title, task.description, task.type, task.assigned]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return haystack.includes(needle);
    })
    .sort((a, b) => new Date(b.updatedAt ?? 0).getTime() - new Date(a.updatedAt ?? 0).getTime())
    .slice(0, limit);
}

module.exports = {
  readTasksState,
  writeTasksState,
  upsertTask,
  getActiveTasks,
  getTasks,
  searchTasks,
  getParentTasks,
  wouldCreateCycle,
  CONFIDENCE_AUTO_APPROVE_THRESHOLD,
};

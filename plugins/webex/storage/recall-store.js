// ********* STORAGE/RECALL-STORE.JS *********
'use strict';

// v3 §9 recall/vector index (phase 7) — one index per space (recall-index.json),
// same per-space-not-per-thread convention as tasks-store.js. Entries are
// write-once: created here, never mutated afterward. Supersession is a
// separate reverse-lookup index (old_id -> new_id rows, recall-supersession.json),
// same non-mutation principle and same reverse-index-table pattern as
// tasks-store.js's task-parents.json — this keeps every entry genuinely
// immutable after creation.

const fs = require('node:fs/promises');
const crypto = require('node:crypto');

const {
  contextDir,
  recallIndexPath,
  recallSupersessionIndexPath,
} = require('./paths');
const { writeJsonFileAtomic } = require('./atomic-write');

// ** Recall entry shape ** {
//   schemaVersion: 1,
//   id: 'recall_...',
//   space_id: string,
//   thread_id: string,        // ranking signal only, never a hard filter —
//                              // see recall/similarity.js.
//   summary_text: string,     // distilled gist of the batch, NOT raw message text.
//   keywords: [...],          // extracted at write time, for hybrid retrieval.
//   message_ids: [...],       // backreference for fetching raw evidence.
//   created_at: ISO datetime,
//   embedding: number[],      // embeds summary_text, not the raw batch.
// }
// `supersedes` is never stored on the entry itself — set only via a row in
// the separate reverse-index file, same non-mutation principle as
// tasks-store.js's parent_tasks.

function defaultRecallIndexState() {
  return {
    schemaVersion: 1,
    entries: [],
    updatedAt: null,
  };
}

function defaultSupersessionIndexState() {
  return {
    schemaVersion: 1,
    rows: [], // { oldId, newId }
  };
}

function generateRecallEntryId() {
  return `recall_${crypto.randomBytes(8).toString('hex')}`;
}

// Read/write

async function readRecallIndexState({ spaceId, explicitRoot } = {}) {
  if (!spaceId) throw new Error('spaceId is required');

  try {
    return JSON.parse(
      await fs.readFile(recallIndexPath(spaceId, explicitRoot), 'utf8')
    );
  } catch (err) {
    if (err?.code === 'ENOENT') return defaultRecallIndexState();
    throw err;
  }
}

async function writeRecallIndexState({ spaceId, state, explicitRoot }) {
  if (!spaceId) throw new Error('spaceId is required');

  const defaults = defaultRecallIndexState();
  const record = {
    schemaVersion: state?.schemaVersion ?? defaults.schemaVersion,
    entries: Array.isArray(state?.entries) ? state.entries : defaults.entries,
    updatedAt: new Date().toISOString(),
  };

  await fs.mkdir(contextDir(spaceId, explicitRoot), { recursive: true });
  await writeJsonFileAtomic(recallIndexPath(spaceId, explicitRoot), record);

  return record;
}

async function readSupersessionIndex({ spaceId, explicitRoot } = {}) {
  if (!spaceId) throw new Error('spaceId is required');

  try {
    return JSON.parse(
      await fs.readFile(recallSupersessionIndexPath(spaceId, explicitRoot), 'utf8')
    );
  } catch (err) {
    if (err?.code === 'ENOENT') return defaultSupersessionIndexState();
    throw err;
  }
}

async function writeSupersessionIndex({ spaceId, state, explicitRoot }) {
  if (!spaceId) throw new Error('spaceId is required');

  const defaults = defaultSupersessionIndexState();
  const record = {
    schemaVersion: state?.schemaVersion ?? defaults.schemaVersion,
    rows: Array.isArray(state?.rows) ? state.rows : defaults.rows,
  };

  await fs.mkdir(contextDir(spaceId, explicitRoot), { recursive: true });
  await writeJsonFileAtomic(recallSupersessionIndexPath(spaceId, explicitRoot), record);

  return record;
}

// Writes

// Appends one immutable entry. Returns the created entry (including its
// generated id, needed by the caller to record any supersession rows
// separately via appendSupersessionRow).
async function appendRecallEntry({
  spaceId,
  threadId,
  summaryText,
  keywords,
  messageIds,
  embedding,
  explicitRoot,
}) {
  if (!spaceId) throw new Error('spaceId is required');
  if (!threadId) throw new Error('threadId is required');
  if (!summaryText || typeof summaryText !== 'string' || !summaryText.trim()) {
    throw new Error('summaryText is required');
  }
  if (!Array.isArray(messageIds) || messageIds.length === 0) {
    throw new Error('messageIds must be a non-empty array');
  }
  if (!Array.isArray(embedding) || embedding.length === 0) {
    throw new Error('embedding must be a non-empty array');
  }

  const entry = {
    schemaVersion: 1,
    id: generateRecallEntryId(),
    space_id: spaceId,
    thread_id: threadId,
    summary_text: summaryText,
    keywords: Array.isArray(keywords) ? keywords : [],
    message_ids: messageIds,
    created_at: new Date().toISOString(),
    embedding,
  };

  const state = await readRecallIndexState({ spaceId, explicitRoot });
  await writeRecallIndexState({
    spaceId,
    state: { ...state, entries: [...state.entries, entry] },
    explicitRoot,
  });

  return entry;
}

async function appendSupersessionRow({ spaceId, oldId, newId, explicitRoot }) {
  if (!spaceId) throw new Error('spaceId is required');
  if (!oldId) throw new Error('oldId is required');
  if (!newId) throw new Error('newId is required');

  const state = await readSupersessionIndex({ spaceId, explicitRoot });
  await writeSupersessionIndex({
    spaceId,
    state: { ...state, rows: [...state.rows, { oldId, newId }] },
    explicitRoot,
  });
}

// Reads

async function readRecallEntries({ spaceId, explicitRoot } = {}) {
  if (!spaceId) throw new Error('spaceId is required');

  const state = await readRecallIndexState({ spaceId, explicitRoot });
  return Array.isArray(state.entries) ? state.entries : [];
}

// Walks forward from entryId through the supersession chain (oldId -> newId),
// transitively — every entry that (directly or eventually) supersedes it, in
// discovery order. No cycle-prevention needed (unlike tasks-store.js's
// child_tasks): a new entry only ever supersedes an older one, so a cycle
// isn't structurally possible — the visited-set guard here is just cheap
// insurance, not load-bearing.
async function getSupersedingChain(entryId, { spaceId, explicitRoot, index } = {}) {
  if (!spaceId) throw new Error('spaceId is required');
  if (!entryId) throw new Error('entryId is required');

  const supersessionIndex = index ?? (await readSupersessionIndex({ spaceId, explicitRoot }));

  const newIdsOf = new Map();
  for (const row of supersessionIndex.rows) {
    if (!newIdsOf.has(row.oldId)) newIdsOf.set(row.oldId, []);
    newIdsOf.get(row.oldId).push(row.newId);
  }

  const chain = [];
  const visited = new Set([entryId]);
  const stack = [...(newIdsOf.get(entryId) ?? [])];

  while (stack.length > 0) {
    const current = stack.pop();
    if (visited.has(current)) continue;
    visited.add(current);
    chain.push(current);
    stack.push(...(newIdsOf.get(current) ?? []));
  }

  return chain;
}

module.exports = {
  appendRecallEntry,
  appendSupersessionRow,
  readRecallEntries,
  getSupersedingChain,
};

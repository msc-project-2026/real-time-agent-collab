// ********* CONTEXT/ITEMS-STORE.JS *********
'use strict';

const fs = require('node:fs/promises');
const crypto = require('node:crypto');

const { contextDir, itemsPath } = require('../storage/paths');

function defaultItemsState() {
  return {
    schemaVersion: 1,
    items: [],
    updatedAt: null,
  };
}

// ** Item shape ** {
//     schemaVersion: 1,
//     id: 'item_...',
//     type: 'task|issue|question|decision|risk|dependency|coordination',
//     status: 'open|in_progress|blocked|resolved|stale',
//     title: '',
//     description: '',
//     conversationIds: [],
//     evidenceMessageIds: [],
//     owner: null,
//     createdAt: '',
//     updatedAt: '',
// }

// Read
async function readItemsState({ spaceId, explicitRoot } = {}) {
  if (!spaceId) throw new Error('spaceId is required');

  try {
    return JSON.parse(
      await fs.readFile(itemsPath(spaceId, explicitRoot), 'utf8')
    );
  } catch (err) {
    if (err?.code === 'ENOENT') return defaultItemsState();
    throw err;
  }
}

// Write
async function writeItemsState({ spaceId, state, explicitRoot }) {
  if (!spaceId) throw new Error('spaceId is required');
  if (!state || typeof state !== 'object') {
    throw new Error('state object is required');
  }

  const defaults = defaultItemsState();

  const record = {
    schemaVersion: state.schemaVersion ?? defaults.schemaVersion,
    items: Array.isArray(state.items) ? state.items : defaults.items,
    updatedAt: state.updatedAt ?? new Date().toISOString(),
  };

  await fs.mkdir(contextDir(spaceId, explicitRoot), {
    recursive: true,
  });

  await fs.writeFile(
    itemsPath(spaceId, explicitRoot),
    `${JSON.stringify(record, null, 2)}\n`,
    'utf8'
  );

  return record;
}

// Get Candidate Items
async function getCandidateItems({
  spaceId,
  conversationIds,
  explicitRoot,
  limit = 100,
} = {}) {
  if (!spaceId) throw new Error('spaceId is required');

  const state = await readItemsState({ spaceId, explicitRoot });

  const items = Array.isArray(state?.items) ? state.items : [];
  const touchedConversationIds = new Set(
    Array.isArray(conversationIds) ? conversationIds : []
  );

  return items
    .filter((item) => {
      const activeStatus = ['open', 'in_progress', 'blocked'].includes(
        item.status
      );

      const linkedToTouchedConversation =
        Array.isArray(item.conversationIds) &&
        item.conversationIds.some((id) => touchedConversationIds.has(id));

      return activeStatus || linkedToTouchedConversation;
    })
    .sort((a, b) => {
      const aTime = new Date(a.updatedAt ?? a.createdAt ?? 0).getTime();
      const bTime = new Date(b.updatedAt ?? b.createdAt ?? 0).getTime();
      return bTime - aTime;
    })
    .slice(0, limit);
}

module.exports = {
  readItemsState,
  writeItemsState,
  getCandidateItems,
};

// ********* CONTEXT/CONVERSATIONS-STORE.JS *********
'use strict';

const fs = require('node:fs/promises');
const crypto = require('node:crypto');

const { contextDir, conversationsPath } = require('../storage/paths');

const DEFAULT_CONVERSATIONS_STATE = {
  schemaVersion: 1,
  conversations: [],
  updatedAt: null,
};

// Helpers
function createConversationId() {
  return `conv_${crypto.randomUUID()}`;
}

// *** read in
async function readConversationsState({ spaceId, explicitRoot } = {}) {
  if (!spaceId) throw new Error('spaceId is required');

  try {
    return JSON.parse(
      await fs.readFile(conversationsPath(spaceId, explicitRoot), 'utf8')
    );
  } catch (err) {
    if (err?.code === 'ENOENT') return defaultConversationsState();
    throw err;
  }
}

// *** write out
async function writeConversationsState({ spaceId, state, explicitRoot }) {
  if (!spaceId) throw new Error('spaceId is required');
  if (!state || typeof state !== 'object') {
    throw new Error('state object is required');
  }

  const record = {
    schemaVersion:
      state.schemaVersion ?? DEFAULT_CONVERSATIONS_STATE.schemaVersion,
    conversations: Array.isArray(state.conversations)
      ? state.conversations
      : DEFAULT_CONVERSATIONS_STATE.conversations,
    updatedAt: state.updatedAt ?? new Date().toISOString(),
  };

  await fs.mkdir(contextDir(spaceId, explicitRoot), {
    recursive: true,
  });

  await fs.writeFile(
    conversationsPath(spaceId, explicitRoot),
    `${JSON.stringify(record, null, 2)}\n`,
    'utf8'
  );

  return record;
}

// *** get conversations
async function getConversations({
  spaceId,
  explicitRoot,
  limit = 100,
  statuses,
} = {}) {
  if (!spaceId) throw new Error('spaceId is required');

  const state = await readConversationsState({ spaceId, explicitRoot });

  const conversations = Array.isArray(state?.conversations)
    ? state.conversations
    : [];

  if (Array.isArray(statuses) && statuses.length > 0) {
    const allowed = new Set(statuses);
    conversations = conversations.filter((conv) => allowed.has(conv.status));
  }

  return conversations
    .slice()
    .sort((a, b) => {
      const aTime = new Date(a.updatedAt ?? a.startedAt ?? 0).getTime();
      const bTime = new Date(b.updatedAt ?? b.startedAt ?? 0).getTime();
      return bTime - aTime;
    })
    .slice(0, limit);
}

module.exports = {
  DEFAULT_CONVERSATIONS_STATE,
  getConversations,
};

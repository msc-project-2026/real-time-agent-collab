// ********* CONTEXT/THREADS-STORE.JS *********
'use strict';

const fs = require('node:fs/promises');

const { contextDir, threadsPath } = require('../storage/paths');

const MAIN_THREAD_KEY = '__main__';
const DEFAULT_CONTEXT_WINDOW_SIZE = 10;

function defaultThreadsState() {
  return {
    schemaVersion: 1,
    threads: {},
    updatedAt: null,
  };
}

function getThreadKey(message) {
  return message.parentId ?? MAIN_THREAD_KEY;
}

function formatMessageForContextWindow(message) {
  return {
    id: message.id,
    text: message.text ?? '',
    senderName:
      message.senderName ?? message.personEmail ?? message.personId ?? null,
    createdAt: message.created ?? null,
    parentId: message.parentId ?? null,
  };
}

function createThreadRecordFromMessage(message) {
  const key = getThreadKey(message);
  const isMainThread = key === MAIN_THREAD_KEY;

  return {
    key,
    kind: isMainThread ? 'main' : 'webex_thread',
    rootMessageId: isMainThread ? null : key,
    contextWindow: [],
    updatedAt: null,
  };
}

async function readThreadsState({ spaceId, explicitRoot } = {}) {
  if (!spaceId) throw new Error('spaceId is required');

  try {
    return JSON.parse(
      await fs.readFile(threadsPath(spaceId, explicitRoot), 'utf8')
    );
  } catch (err) {
    if (err?.code === 'ENOENT') return defaultThreadsState();
    throw err;
  }
}

async function writeThreadsState({ spaceId, state, explicitRoot }) {
  if (!spaceId) throw new Error('spaceId is required');
  if (!state || typeof state !== 'object') {
    throw new Error('state object is required');
  }

  const defaults = defaultThreadsState();

  const record = {
    schemaVersion: state.schemaVersion ?? defaults.schemaVersion,
    threads:
      state.threads && typeof state.threads === 'object'
        ? state.threads
        : defaults.threads,
    updatedAt: state.updatedAt ?? new Date().toISOString(),
  };

  await fs.mkdir(contextDir(spaceId, explicitRoot), {
    recursive: true,
  });

  await fs.writeFile(
    threadsPath(spaceId, explicitRoot),
    `${JSON.stringify(record, null, 2)}\n`,
    'utf8'
  );

  return record;
}

function applyMessageToThreadContextWindow({
  state,
  message,
  contextWindowSize = DEFAULT_CONTEXT_WINDOW_SIZE,
}) {
  if (!state || typeof state !== 'object') {
    throw new Error('state object is required');
  }

  if (!message?.id) throw new Error('message.id is required');

  const now = new Date().toISOString();
  const key = getThreadKey(message);

  const existingThread =
    state.threads?.[key] ?? createThreadRecordFromMessage(message);

  const existingContextWindow = Array.isArray(existingThread.contextWindow)
    ? existingThread.contextWindow
    : [];

  const contextWindow = [
    ...existingContextWindow.filter((entry) => entry.id !== message.id),
    formatMessageForContextWindow(message),
  ].slice(-contextWindowSize);

  return {
    ...state,
    threads: {
      ...(state.threads ?? {}),
      [key]: {
        ...existingThread,
        contextWindow,
        updatedAt: now,
      },
    },
    updatedAt: now,
  };
}

async function appendMessageToThreadContextWindow({
  spaceId,
  message,
  explicitRoot,
  contextWindowSize = DEFAULT_CONTEXT_WINDOW_SIZE,
}) {
  if (!spaceId) throw new Error('spaceId is required');
  if (!message?.id) throw new Error('message.id is required');

  const state = await readThreadsState({
    spaceId,
    explicitRoot,
  });

  const newState = applyMessageToThreadContextWindow({
    state,
    message,
    contextWindowSize,
  });

  await writeThreadsState({
    spaceId,
    state: newState,
    explicitRoot,
  });

  return {
    threadKey: getThreadKey(message),
  };
}

module.exports = {
  MAIN_THREAD_KEY,
  DEFAULT_CONTEXT_WINDOW_SIZE,

  getThreadKey,
  appendMessageToThreadContextWindow,
};

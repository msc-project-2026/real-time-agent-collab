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

function createThreadRecordFromKey({ key }) {
  if (!key) throw new Error('thread key is required');

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
  threadKeyOverride,
  contextWindowSize = DEFAULT_CONTEXT_WINDOW_SIZE,
}) {
  if (!state || typeof state !== 'object') {
    throw new Error('state object is required');
  }

  if (!message?.id) throw new Error('message.id is required');

  const now = new Date().toISOString();
  const key = threadKeyOverride ?? getThreadKey(message);

  const existingThread =
    state.threads?.[key] ?? createThreadRecordFromKey({ key });

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
  explicitRoot,
  message,
  log,
  fetchMessageById,
  contextWindowSize = DEFAULT_CONTEXT_WINDOW_SIZE,
}) {
  if (!spaceId) throw new Error('spaceId is required');
  if (!message?.id) throw new Error('message.id is required');

  const threadKey = getThreadKey(message);

  let state = await readThreadsState({
    spaceId,
    explicitRoot,
  });

  const threadExists = Boolean(state.threads?.[threadKey]);

  if (threadKey !== MAIN_THREAD_KEY && !threadExists) {
    if (typeof fetchMessageById === 'function') {
      try {
        const rootMessage = await fetchMessageById(message.parentId);

        if (rootMessage?.id) {
          state = applyMessageToThreadContextWindow({
            state,
            rootMessage,
            threadKeyOverride: threadKey,
            contextWindowSize,
          });
        } else {
          log?.warn?.(
            `[webex] root message fetch returned invalid message ${JSON.stringify(
              {
                spaceId,
                parentId: message.parentId,
                rootMessage,
              }
            )}`
          );
        }
      } catch (err) {
        log?.warn?.(
          `[webex] failed to seed thread root message ${JSON.stringify({
            spaceId,
            parentId: message.parentId,
            error: err?.message ?? String(err),
          })}`
        );
      }
    }
  }

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
    threadKey,
  };
}

// Helpers

function getThreadFromState({ state, threadKey, excludeMessageIds = [] } = {}) {
  if (!threadKey) throw new Error('threadKey is required');

  const excluded = new Set(excludeMessageIds);
  const thread = state?.threads?.[threadKey];

  if (!thread) {
    const isMainThread = threadKey === MAIN_THREAD_KEY;

    return {
      key: threadKey,
      kind: isMainThread ? 'main' : 'webex_thread',
      rootMessageId: isMainThread ? null : threadKey,
      contextWindow: [],
      updatedAt: null,
    };
  }

  return {
    ...thread,
    contextWindow: Array.isArray(thread.contextWindow)
      ? thread.contextWindow.filter((entry) => !excluded.has(entry.id))
      : [],
  };
}

async function getThread({
  spaceId,
  threadKey,
  explicitRoot,
  excludeMessageIds = [],
} = {}) {
  if (!spaceId) throw new Error('spaceId is required');

  const state = await readThreadsState({
    spaceId,
    explicitRoot,
  });

  return getThreadFromState({
    state,
    threadKey,
    excludeMessageIds,
  });
}

module.exports = {
  MAIN_THREAD_KEY,
  DEFAULT_CONTEXT_WINDOW_SIZE,

  getThreadKey,
  appendMessageToThreadContextWindow,
  getThread,
};

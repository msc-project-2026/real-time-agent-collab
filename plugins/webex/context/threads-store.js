// ********* CONTEXT/THREADS-STORE.JS *********
'use strict';

const fs = require('node:fs/promises');

const { contextDir, threadsPath } = require('../storage/paths');

const MAIN_THREAD_KEY = '__main__';
const DEFAULT_CONTEXT_WINDOW_SIZE = 10;
const DEFAULT_PROCESSED_WINDOW_SIZE = 10;
// Not enforced here — the pending slice is never storage-evicted (a message, once
// stored, must survive regardless of what tagging/dispatch later decide). This is
// exported for the dispatch layer to compare against when deciding to force a flush.
const DEFAULT_PENDING_BACKSTOP_SIZE = 50;

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

// v3 §3 message metadata shape, used by the pending/processed thread window.
function formatMessageForThreadWindow({ message, botId, status }) {
  const botIsMentioned =
    Boolean(botId) &&
    Array.isArray(message.mentionedPeople) &&
    message.mentionedPeople.includes(botId);

  return {
    id: message.id,
    threadId: message.parentId ?? null,
    senderId: message.personId ?? null,
    senderName:
      message.senderName ?? message.personEmail ?? message.personId ?? null,
    content: message.text ?? '',
    botIsMentioned,
    datetime: message.created ?? null,
    status,
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
    pending: [],
    processed: [],
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

function applyMessageToPendingWindow({ state, message, botId, threadKeyOverride }) {
  if (!state || typeof state !== 'object') {
    throw new Error('state object is required');
  }

  if (!message?.id) throw new Error('message.id is required');

  const now = new Date().toISOString();
  const key = threadKeyOverride ?? getThreadKey(message);

  const existingThread =
    state.threads?.[key] ?? createThreadRecordFromKey({ key });

  const existingPending = Array.isArray(existingThread.pending)
    ? existingThread.pending
    : [];

  // No cap here — a message, once stored, must survive regardless of what
  // tagging/dispatch later decide (§3 durability). DEFAULT_PENDING_BACKSTOP_SIZE
  // is a signal for the dispatch layer to force a flush, not a storage eviction.
  const pending = [
    ...existingPending.filter((entry) => entry.id !== message.id),
    formatMessageForThreadWindow({ message, botId, status: 'pending' }),
  ];

  return {
    ...state,
    threads: {
      ...(state.threads ?? {}),
      [key]: {
        ...existingThread,
        pending,
        processed: Array.isArray(existingThread.processed)
          ? existingThread.processed
          : [],
        updatedAt: now,
      },
    },
    updatedAt: now,
  };
}

// For content that's background only, never something awaiting a dispatch
// decision in this thread: bot-authored messages (nothing to act on in the
// bot's own words) and a new thread's backfilled root (context for the
// reply that created the thread, not new content — see the root-backfill
// call site below). Appended straight to processed (capped, same as a
// normal flush) so it still counts as background for the gate (§4's
// minContext padding, tagging/dispatch.js) and the respond step's window,
// without inflating pendingCount/the backstop — those are meant to reflect
// unaddressed human backlog specifically, not resurrect something that
// already triggered its own response elsewhere.
function applyMessageDirectlyToProcessedWindow({
  state,
  message,
  botId,
  threadKeyOverride,
  processedWindowSize = DEFAULT_PROCESSED_WINDOW_SIZE,
}) {
  if (!state || typeof state !== 'object') {
    throw new Error('state object is required');
  }

  if (!message?.id) throw new Error('message.id is required');

  const now = new Date().toISOString();
  const key = threadKeyOverride ?? getThreadKey(message);

  const existingThread =
    state.threads?.[key] ?? createThreadRecordFromKey({ key });

  const existingProcessed = Array.isArray(existingThread.processed)
    ? existingThread.processed
    : [];

  const processed = [
    ...existingProcessed.filter((entry) => entry.id !== message.id),
    formatMessageForThreadWindow({ message, botId, status: 'processed' }),
  ].slice(-processedWindowSize);

  return {
    ...state,
    threads: {
      ...(state.threads ?? {}),
      [key]: {
        ...existingThread,
        pending: Array.isArray(existingThread.pending)
          ? existingThread.pending
          : [],
        processed,
        updatedAt: now,
      },
    },
    updatedAt: now,
  };
}

async function appendMessageToThreadWindow({
  spaceId,
  explicitRoot,
  message,
  botId,
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

        log?.info?.(
          `[webex] fetched thread root message ${JSON.stringify({
            spaceId,
            parentId: message.parentId,
            hasRootMessage: Boolean(rootMessage),
            rootMessageKeys:
              rootMessage && typeof rootMessage === 'object'
                ? Object.keys(rootMessage)
                : null,
            rootMessageId: rootMessage?.id ?? null,
          })}`
        );

        if (rootMessage?.id) {
          state = applyMessageToThreadContextWindow({
            state,
            message: rootMessage,
            threadKeyOverride: threadKey,
            contextWindowSize,
          });
          // Always processed, never pending, regardless of who sent it. The
          // root's only role here is background for the reply that created
          // this thread — it isn't new content awaiting a dispatch decision
          // in this thread (that decision, if any, already happened wherever
          // the root message actually lives — e.g. __main__ — this is a
          // backfilled copy for context, not the same tracked instance).
          // Branching this on sender identity was wrong: a human-authored
          // root that already triggered its own response elsewhere would
          // otherwise get resurrected as pending here, double-counting it
          // and inflating pendingCount for a message nobody still needs to
          // act on.
          state = applyMessageDirectlyToProcessedWindow({
            state,
            message: rootMessage,
            botId,
            threadKeyOverride: threadKey,
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

  let newState = applyMessageToThreadContextWindow({
    state,
    message,
    contextWindowSize,
  });
  const applyMessage =
    Boolean(botId) && message.personId === botId
      ? applyMessageDirectlyToProcessedWindow
      : applyMessageToPendingWindow;
  newState = applyMessage({
    state: newState,
    message,
    botId,
  });

  await writeThreadsState({
    spaceId,
    state: newState,
    explicitRoot,
  });

  return {
    threadKey,
    pendingCount: newState.threads[threadKey].pending.length,
  };
}

// Moves the given message ids from a thread's pending window into its processed
// window (v3 §2 flush). The processed window is size-capped; pending is not.
async function markThreadMessagesProcessed({
  spaceId,
  threadKey,
  messageIds,
  explicitRoot,
  processedWindowSize = DEFAULT_PROCESSED_WINDOW_SIZE,
}) {
  if (!spaceId) throw new Error('spaceId is required');
  if (!threadKey) throw new Error('threadKey is required');
  if (!Array.isArray(messageIds) || messageIds.length === 0) {
    throw new Error('messageIds must be a non-empty array');
  }

  const state = await readThreadsState({ spaceId, explicitRoot });
  const existingThread =
    state.threads?.[threadKey] ?? createThreadRecordFromKey({ key: threadKey });

  const idsToFlush = new Set(messageIds);
  const existingPending = Array.isArray(existingThread.pending)
    ? existingThread.pending
    : [];
  const existingProcessed = Array.isArray(existingThread.processed)
    ? existingThread.processed
    : [];

  const flushed = existingPending
    .filter((entry) => idsToFlush.has(entry.id))
    .map((entry) => ({ ...entry, status: 'processed' }));

  const now = new Date().toISOString();

  const newState = {
    ...state,
    threads: {
      ...(state.threads ?? {}),
      [threadKey]: {
        ...existingThread,
        pending: existingPending.filter((entry) => !idsToFlush.has(entry.id)),
        processed: [
          ...existingProcessed.filter((entry) => !idsToFlush.has(entry.id)),
          ...flushed,
        ].slice(-processedWindowSize),
        updatedAt: now,
      },
    },
    updatedAt: now,
  };

  await writeThreadsState({ spaceId, state: newState, explicitRoot });

  return getThreadFromState({ state: newState, threadKey });
}

// The thread's pending slice (v3 §4 tagging-gate context), in arrival order.
async function getPendingSlice({ spaceId, threadKey, explicitRoot }) {
  if (!spaceId) throw new Error('spaceId is required');
  if (!threadKey) throw new Error('threadKey is required');

  const state = await readThreadsState({ spaceId, explicitRoot });
  const thread = state.threads?.[threadKey];

  return Array.isArray(thread?.pending) ? thread.pending : [];
}

// Getters

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
      pending: [],
      processed: [],
      updatedAt: null,
    };
  }

  return {
    ...thread,
    contextWindow: Array.isArray(thread.contextWindow)
      ? thread.contextWindow.filter((entry) => !excluded.has(entry.id))
      : [],
    pending: Array.isArray(thread.pending)
      ? thread.pending.filter((entry) => !excluded.has(entry.id))
      : [],
    processed: Array.isArray(thread.processed)
      ? thread.processed.filter((entry) => !excluded.has(entry.id))
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

async function getThreads({ spaceId, explicitRoot, limit = 100, kinds } = {}) {
  if (!spaceId) throw new Error('spaceId is required');

  const state = await readThreadsState({
    spaceId,
    explicitRoot,
  });

  let threads = Object.values(state.threads ?? {});

  if (Array.isArray(kinds) && kinds.length > 0) {
    const allowedKinds = new Set(kinds);
    threads = threads.filter((thread) => allowedKinds.has(thread.kind));
  }

  return threads
    .slice()
    .sort((a, b) => {
      const aTime = new Date(a.updatedAt ?? 0).getTime();
      const bTime = new Date(b.updatedAt ?? 0).getTime();
      return bTime - aTime;
    })
    .slice(0, limit);
}

module.exports = {
  MAIN_THREAD_KEY,
  DEFAULT_CONTEXT_WINDOW_SIZE,
  DEFAULT_PROCESSED_WINDOW_SIZE,
  DEFAULT_PENDING_BACKSTOP_SIZE,

  getThreadKey,
  appendMessageToThreadWindow,
  markThreadMessagesProcessed,
  getPendingSlice,
  getThread,
  getThreads,
};

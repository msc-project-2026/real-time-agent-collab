// ********* STORAGE/THREADS-STORE.JS *********
'use strict';

const fs = require('node:fs/promises');

const { contextDir, threadsPath } = require('./paths');
const { writeJsonFileAtomic } = require('./atomic-write');
const { withLock } = require('../flow/keyed-lock');
const { readActiveConfig } = require('../config/store');

const MAIN_THREAD_KEY = '__main__';
const DEFAULT_PROCESSED_WINDOW_SIZE = 10;
// Not enforced here — the pending slice is never storage-evicted (a message, once
// stored, must survive regardless of what tagging/dispatch later decide). This is
// exported for the dispatch layer to compare against when deciding to force a flush.
const DEFAULT_PENDING_BACKSTOP_SIZE = 50;

function storeWriteLockKey(spaceId) {
  return `store-write:${spaceId}`;
}

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

// v3 §3 message metadata shape, used by the pending/processing/processed
// thread window. No `status` field — which array an entry lives in (pending /
// processing / processed) is its status; a redundant per-entry field pointing
// at the same information was flagged as two sources of truth for one fact
// during phase-6 review and dropped in favor of array membership alone.
//
// senderName resolution (config card consolidation, §2a): substituting a
// friendly name for a raw email happens once, here, at write time — every
// downstream prompt-builder (gate/extract/summarize/respond) reads the
// already-stored value, not the raw message again, so this is the single
// point that needs to know about the member cache. Resolution order: cached
// name (override or Webex-refreshed, matched by email) → personEmail →
// personId → null, same fallback chain as before, with a real lookup
// inserted at the front.
async function resolveSenderName({ message, spaceId, explicitRoot }) {
  if (message.senderName) return message.senderName;
  if (!spaceId || !message.personEmail) return message.personEmail ?? message.personId ?? null;

  const members = (await readActiveConfig({ spaceId, explicitRoot }))?.members ?? [];
  const match = members.find((member) => member.email === message.personEmail);

  return match?.name ?? message.personEmail ?? message.personId ?? null;
}

async function formatMessageForThreadWindow({ message, botId, spaceId, explicitRoot }) {
  const botIsMentioned =
    Boolean(botId) &&
    Array.isArray(message.mentionedPeople) &&
    message.mentionedPeople.includes(botId);

  return {
    id: message.id,
    threadId: message.parentId ?? null,
    senderId: message.personId ?? null,
    senderName: await resolveSenderName({ message, spaceId, explicitRoot }),
    content: message.text ?? '',
    botIsMentioned,
    datetime: message.created ?? null,
  };
}

function createThreadRecordFromKey({ key }) {
  if (!key) throw new Error('thread key is required');

  const isMainThread = key === MAIN_THREAD_KEY;

  return {
    key,
    kind: isMainThread ? 'main' : 'webex_thread',
    rootMessageId: isMainThread ? null : key,
    pending: [],
    processing: [],
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

  await writeJsonFileAtomic(threadsPath(spaceId, explicitRoot), record);

  return record;
}

async function applyMessageToPendingWindow({
  state,
  message,
  botId,
  threadKeyOverride,
  spaceId,
  explicitRoot,
}) {
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
    await formatMessageForThreadWindow({ message, botId, spaceId, explicitRoot }),
  ];

  return {
    ...state,
    threads: {
      ...(state.threads ?? {}),
      [key]: {
        ...existingThread,
        pending,
        processing: Array.isArray(existingThread.processing)
          ? existingThread.processing
          : [],
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
// minContext padding, gate/dispatch.js) and the respond/extract steps'
// window, without inflating pendingCount/the backstop — those are meant to
// reflect unaddressed human backlog specifically, not resurrect something
// that already triggered its own response elsewhere.
async function applyMessageDirectlyToProcessedWindow({
  state,
  message,
  botId,
  threadKeyOverride,
  processedWindowSize = DEFAULT_PROCESSED_WINDOW_SIZE,
  spaceId,
  explicitRoot,
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
    await formatMessageForThreadWindow({ message, botId, spaceId, explicitRoot }),
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
        processing: Array.isArray(existingThread.processing)
          ? existingThread.processing
          : [],
        processed,
        updatedAt: now,
      },
    },
    updatedAt: now,
  };
}

// Layer 1 (phase-6 concurrency design) — every mutator below wraps its own
// read-modify-write in this per-space lock. threads.json is one file per
// SPACE (not per thread, see storage/paths.js), so two flows touching
// *different* threads in the same space still share this file and need this
// to avoid a lost update, even though higher-level ordering (the per-thread
// gate+flush lock, per-space extract lock — both in flow/run-message-flow.js)
// is scoped more narrowly than "every writer to this file."
async function appendMessageToThreadWindow({
  spaceId,
  explicitRoot,
  message,
  botId,
  log,
  fetchMessageById,
}) {
  if (!spaceId) throw new Error('spaceId is required');
  if (!message?.id) throw new Error('message.id is required');

  return withLock(storeWriteLockKey(spaceId), async () => {
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
            state = await applyMessageDirectlyToProcessedWindow({
              state,
              message: rootMessage,
              botId,
              threadKeyOverride: threadKey,
              spaceId,
              explicitRoot,
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

    const applyMessage =
      Boolean(botId) && message.personId === botId
        ? applyMessageDirectlyToProcessedWindow
        : applyMessageToPendingWindow;
    const newState = await applyMessage({
      state,
      message,
      botId,
      spaceId,
      explicitRoot,
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
  });
}

// Moves the given message ids from a thread's pending window into its
// processing window (v3 §2 flush) — the batch a flow has just claimed, not
// yet finalized. No size cap here (processing is a transient, bounded-by-one-
// flush buffer, not a rolling history window like processed).
async function markThreadMessagesProcessing({
  spaceId,
  threadKey,
  messageIds,
  explicitRoot,
}) {
  if (!spaceId) throw new Error('spaceId is required');
  if (!threadKey) throw new Error('threadKey is required');
  if (!Array.isArray(messageIds) || messageIds.length === 0) {
    throw new Error('messageIds must be a non-empty array');
  }

  return withLock(storeWriteLockKey(spaceId), async () => {
    const state = await readThreadsState({ spaceId, explicitRoot });
    const existingThread =
      state.threads?.[threadKey] ?? createThreadRecordFromKey({ key: threadKey });

    const idsToFlush = new Set(messageIds);
    const existingPending = Array.isArray(existingThread.pending)
      ? existingThread.pending
      : [];
    const existingProcessing = Array.isArray(existingThread.processing)
      ? existingThread.processing
      : [];

    const flushed = existingPending.filter((entry) => idsToFlush.has(entry.id));

    const now = new Date().toISOString();

    const newState = {
      ...state,
      threads: {
        ...(state.threads ?? {}),
        [threadKey]: {
          ...existingThread,
          pending: existingPending.filter((entry) => !idsToFlush.has(entry.id)),
          processing: [
            ...existingProcessing.filter((entry) => !idsToFlush.has(entry.id)),
            ...flushed,
          ],
          updatedAt: now,
        },
      },
      updatedAt: now,
    };

    await writeThreadsState({ spaceId, state: newState, explicitRoot });

    return getThreadFromState({ state: newState, threadKey });
  });
}

// Moves the given message ids from a thread's processing window into its
// processed window, once whatever flow claimed them (extract/respond) has
// settled. Processed is size-capped; a processing entry evicted by the cap
// before finalization runs is a harmless no-op for that id.
async function finalizeProcessingMessages({
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

  return withLock(storeWriteLockKey(spaceId), async () => {
    const state = await readThreadsState({ spaceId, explicitRoot });
    const existingThread =
      state.threads?.[threadKey] ?? createThreadRecordFromKey({ key: threadKey });

    const idsToFinalize = new Set(messageIds);
    const existingProcessing = Array.isArray(existingThread.processing)
      ? existingThread.processing
      : [];
    const existingProcessed = Array.isArray(existingThread.processed)
      ? existingThread.processed
      : [];

    const finalized = existingProcessing.filter((entry) =>
      idsToFinalize.has(entry.id)
    );

    const now = new Date().toISOString();

    const newState = {
      ...state,
      threads: {
        ...(state.threads ?? {}),
        [threadKey]: {
          ...existingThread,
          processing: existingProcessing.filter(
            (entry) => !idsToFinalize.has(entry.id)
          ),
          processed: [
            ...existingProcessed.filter((entry) => !idsToFinalize.has(entry.id)),
            ...finalized,
          ].slice(-processedWindowSize),
          updatedAt: now,
        },
      },
      updatedAt: now,
    };

    await writeThreadsState({ spaceId, state: newState, explicitRoot });

    return getThreadFromState({ state: newState, threadKey });
  });
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
      pending: [],
      processing: [],
      processed: [],
      updatedAt: null,
    };
  }

  return {
    ...thread,
    pending: Array.isArray(thread.pending)
      ? thread.pending.filter((entry) => !excluded.has(entry.id))
      : [],
    processing: Array.isArray(thread.processing)
      ? thread.processing.filter((entry) => !excluded.has(entry.id))
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
  DEFAULT_PROCESSED_WINDOW_SIZE,
  DEFAULT_PENDING_BACKSTOP_SIZE,

  getThreadKey,
  appendMessageToThreadWindow,
  markThreadMessagesProcessing,
  finalizeProcessingMessages,
  getPendingSlice,
  getThread,
  getThreads,
};

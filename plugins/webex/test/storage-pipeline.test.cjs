'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { describe, test } = require('node:test');

const { spaceDir } = require('../storage/paths');
const {
  MAIN_THREAD_KEY,
  appendMessageToThreadWindow,
  markThreadMessagesProcessing,
  finalizeProcessingMessages,
  getPendingSlice,
  getThread,
  getThreads,
} = require('../storage/threads-store');
const { readActiveConfig, writeActiveConfig, writeCachedMembers } = require('../config/store');
const { makeTempWorkspace } = require('./helpers.cjs');

// Category: Safe per-space storage paths.
// These tests verify externally supplied space identifiers cannot escape the workspace's collaboration storage tree.
describe('storage paths', () => {
  test('sanitises path separators and punctuation in space identifiers', async (t) => {
    const root = await makeTempWorkspace(t);
    const resolved = spaceDir('../../space/name', root);

    assert.equal(resolved, path.join(root, '.collab', 'spaces', '.._.._space_name'));
    assert.ok(resolved.startsWith(path.join(root, '.collab', 'spaces')));
  });
});

describe('thread context windows', () => {
  test('seeds a new reply thread with its root before the reply', async (t) => {
    const root = await makeTempWorkspace(t);
    const fetchMessageById = t.mock.fn(async () => ({
      id: 'root-1',
      text: 'Root',
      personId: 'person-1',
    }));

    await appendMessageToThreadWindow({
      spaceId: 'space-1',
      explicitRoot: root,
      message: {
        id: 'reply-1',
        parentId: 'root-1',
        text: 'Reply',
        personId: 'person-2',
      },
      fetchMessageById,
      log: { info: t.mock.fn(), warn: t.mock.fn() },
    });

    const thread = await getThread({
      spaceId: 'space-1',
      explicitRoot: root,
      threadKey: 'root-1',
    });
    assert.equal(fetchMessageById.mock.callCount(), 1);
    assert.equal(thread.kind, 'webex_thread');
    assert.equal(thread.rootMessageId, 'root-1');
    // The backfilled root (human-authored here) is background, not new
    // content awaiting judgment in this thread — it goes straight to
    // processed regardless of who sent it, same as a bot-authored root.
    // Only the actual reply that created the thread is pending.
    assert.deepEqual(thread.pending.map((message) => message.id), ['reply-1']);
    assert.deepEqual(thread.processed.map((message) => message.id), ['root-1']);
  });

  test('seeds a new reply thread with a bot-authored root directly into processed', async (t) => {
    const root = await makeTempWorkspace(t);
    const fetchMessageById = t.mock.fn(async () => ({
      id: 'bot-root-1',
      text: 'Hey! How can I help?',
      personId: 'bot-1',
    }));

    await appendMessageToThreadWindow({
      spaceId: 'space-1',
      explicitRoot: root,
      botId: 'bot-1',
      message: {
        id: 'reply-1',
        parentId: 'bot-root-1',
        text: 'Great, are you well?',
        personId: 'person-1',
      },
      fetchMessageById,
      log: { info: t.mock.fn(), warn: t.mock.fn() },
    });

    const thread = await getThread({
      spaceId: 'space-1',
      explicitRoot: root,
      threadKey: 'bot-root-1',
    });
    // The root (bot's own prior message) is background, not something to
    // judge — it lands in processed. Only the human's reply is pending.
    assert.deepEqual(thread.pending.map((message) => message.id), ['reply-1']);
    assert.deepEqual(thread.processed.map((message) => message.id), ['bot-root-1']);
  });

  test('records an outbound bot send into a brand-new thread via a synthetic (non-network) fetchMessageById', async (t) => {
    // Mirrors how send.js's sendOutboundMessage seeds a new thread for our
    // own replies — the triggering message is already in memory (the same
    // object the flow has been carrying since it arrived), so there's no
    // need for a real Webex API round-trip the way the inbound side needs
    // one for a message it's never seen before.
    const root = await makeTempWorkspace(t);
    const triggeringMessage = { id: 'main-question-1', text: 'What is the board URL?', personId: 'person-1' };
    const fetchMessageById = t.mock.fn(async () => triggeringMessage);

    await appendMessageToThreadWindow({
      spaceId: 'space-1',
      explicitRoot: root,
      botId: 'bot-1',
      message: {
        id: 'bot-reply-1',
        parentId: 'main-question-1',
        text: 'Here you go: https://example/board',
        personId: 'bot-1',
      },
      fetchMessageById,
      log: { info: t.mock.fn(), warn: t.mock.fn() },
    });

    assert.equal(fetchMessageById.mock.callCount(), 1);

    const thread = await getThread({
      spaceId: 'space-1',
      explicitRoot: root,
      threadKey: 'main-question-1',
    });
    // The bot's own reply is bot-authored — straight to processed, never
    // pending, same rule whether it arrived via inbound webhook echo (as
    // tested above) or was recorded directly at send time.
    assert.deepEqual(thread.pending, []);
    assert.deepEqual(thread.processed.map((m) => m.id), ['main-question-1', 'bot-reply-1']);
  });

  test('filters and orders thread listings', async (t) => {
    const root = await makeTempWorkspace(t);
    await appendMessageToThreadWindow({
      spaceId: 'space-1',
      explicitRoot: root,
      message: { id: 'main-1', text: 'Main' },
    });
    await appendMessageToThreadWindow({
      spaceId: 'space-1',
      explicitRoot: root,
      message: { id: 'reply-1', parentId: 'root-1', text: 'Reply' },
    });

    const replyThreads = await getThreads({
      spaceId: 'space-1',
      explicitRoot: root,
      kinds: ['webex_thread'],
    });
    assert.deepEqual(replyThreads.map((thread) => thread.key), ['root-1']);
  });
});

// Category: Pending/processed thread window (v3 §2, §3, §4).
// These tests verify every arriving message is durably tagged pending with full
// v3 metadata regardless of the (unrelated, size-capped) legacy context window,
// that the pending slice is never storage-evicted, and that flushing moves
// messages into a size-capped processed window.
describe('pending/processed thread window', () => {
  test('tags an arriving message pending with v3 metadata, independent of the capped context window', async (t) => {
    const root = await makeTempWorkspace(t);

    let lastResult;
    for (let index = 1; index <= 4; index += 1) {
      lastResult = await appendMessageToThreadWindow({
        spaceId: 'space-1',
        explicitRoot: root,
        contextWindowSize: 3,
        botId: 'bot-1',
        message: {
          id: `message-${index}`,
          text: `Message ${index}`,
          personId: 'person-1',
          personEmail: 'dev@example.com',
          created: `2026-01-0${index}T00:00:00.000Z`,
          mentionedPeople: index === 4 ? ['bot-1'] : [],
        },
      });
    }

    // The append result reports the pending count directly so a future dispatch
    // layer can check the backstop cap without a second read (v3 §2).
    assert.equal(lastResult.pendingCount, 4);

    const thread = await getThread({
      spaceId: 'space-1',
      explicitRoot: root,
      threadKey: MAIN_THREAD_KEY,
    });

    // The legacy context window is capped at 3 and lost message-1, but the
    // pending window must retain every message — nothing is storage-evicted.
    assert.deepEqual(thread.pending.map((message) => message.id), [
      'message-1',
      'message-2',
      'message-3',
      'message-4',
    ]);

    assert.deepEqual(thread.pending[0], {
      id: 'message-1',
      threadId: null,
      senderId: 'person-1',
      senderName: 'dev@example.com',
      content: 'Message 1',
      botIsMentioned: false,
      datetime: '2026-01-01T00:00:00.000Z',
    });
    assert.equal(thread.pending[3].botIsMentioned, true);
    assert.deepEqual(thread.processing, []);
    assert.deepEqual(thread.processed, []);
  });

  test('routes bot-authored messages straight into processed, never pending', async (t) => {
    const root = await makeTempWorkspace(t);

    await appendMessageToThreadWindow({
      spaceId: 'space-1',
      explicitRoot: root,
      botId: 'bot-1',
      message: {
        id: 'human-1',
        text: 'Are you there?',
        personId: 'person-1',
        personEmail: 'dev@example.com',
        created: '2026-01-01T00:00:00.000Z',
      },
    });
    const result = await appendMessageToThreadWindow({
      spaceId: 'space-1',
      explicitRoot: root,
      botId: 'bot-1',
      message: {
        id: 'bot-1-reply',
        text: 'Yes, I am here.',
        personId: 'bot-1',
        created: '2026-01-01T00:00:05.000Z',
      },
    });

    // The bot's own message never counts toward pendingCount — it's not
    // unaddressed human backlog, so it shouldn't inflate the backstop either.
    assert.equal(result.pendingCount, 1);

    const thread = await getThread({
      spaceId: 'space-1',
      explicitRoot: root,
      threadKey: MAIN_THREAD_KEY,
    });

    assert.deepEqual(thread.pending.map((message) => message.id), ['human-1']);
    assert.deepEqual(thread.processed.map((message) => message.id), ['bot-1-reply']);
  });

  // config card consolidation, §2a: a sender's email is substituted for a
  // friendly name once, at write time, using the space's cached member
  // mapping — every downstream prompt-builder then reads the already-stored
  // name for free.
  test('resolves senderName through the cached member mapping when one exists', async (t) => {
    const root = await makeTempWorkspace(t);
    await writeCachedMembers({
      spaceId: 'space-1',
      explicitRoot: root,
      members: [{ id: 'person-1', email: 'dev@example.com', name: 'Ada', source: 'webex' }],
    });

    await appendMessageToThreadWindow({
      spaceId: 'space-1',
      explicitRoot: root,
      message: {
        id: 'message-1',
        text: 'Hello',
        personId: 'person-1',
        personEmail: 'dev@example.com',
        created: '2026-01-01T00:00:00.000Z',
      },
    });

    const thread = await getThread({
      spaceId: 'space-1',
      explicitRoot: root,
      threadKey: MAIN_THREAD_KEY,
    });
    assert.equal(thread.pending[0].senderName, 'Ada');
  });

  test('falls back to personEmail then personId when no cached mapping matches', async (t) => {
    const root = await makeTempWorkspace(t);

    await appendMessageToThreadWindow({
      spaceId: 'space-1',
      explicitRoot: root,
      message: {
        id: 'message-1',
        text: 'Hello',
        personId: 'person-1',
        personEmail: 'dev@example.com',
        created: '2026-01-01T00:00:00.000Z',
      },
    });
    await appendMessageToThreadWindow({
      spaceId: 'space-1',
      explicitRoot: root,
      message: {
        id: 'message-2',
        text: 'Hello again',
        personId: 'person-2',
        created: '2026-01-01T00:00:01.000Z',
      },
    });

    const thread = await getThread({
      spaceId: 'space-1',
      explicitRoot: root,
      threadKey: MAIN_THREAD_KEY,
    });
    assert.equal(thread.pending[0].senderName, 'dev@example.com');
    assert.equal(thread.pending[1].senderName, 'person-2');
  });

  test('exposes the pending slice directly for the tagging gate', async (t) => {
    const root = await makeTempWorkspace(t);
    await appendMessageToThreadWindow({
      spaceId: 'space-1',
      explicitRoot: root,
      message: { id: 'message-1', text: 'Hello' },
    });

    const slice = await getPendingSlice({
      spaceId: 'space-1',
      explicitRoot: root,
      threadKey: MAIN_THREAD_KEY,
    });
    assert.deepEqual(slice.map((message) => message.id), ['message-1']);
  });

  test('flushes selected messages from pending into processing, then finalizes into a size-capped processed window', async (t) => {
    const root = await makeTempWorkspace(t);

    for (let index = 1; index <= 3; index += 1) {
      await appendMessageToThreadWindow({
        spaceId: 'space-1',
        explicitRoot: root,
        message: { id: `message-${index}`, text: `Message ${index}` },
      });
    }

    const flushed = await markThreadMessagesProcessing({
      spaceId: 'space-1',
      explicitRoot: root,
      threadKey: MAIN_THREAD_KEY,
      messageIds: ['message-1', 'message-2'],
    });

    // Flush moves the batch into `processing`, not straight to `processed` —
    // it's claimed by whatever flow triggered the flush, not yet settled.
    assert.deepEqual(flushed.pending.map((message) => message.id), [
      'message-3',
    ]);
    assert.deepEqual(flushed.processing.map((message) => message.id), [
      'message-1',
      'message-2',
    ]);
    assert.deepEqual(flushed.processed, []);

    const finalized = await finalizeProcessingMessages({
      spaceId: 'space-1',
      explicitRoot: root,
      threadKey: MAIN_THREAD_KEY,
      messageIds: ['message-1', 'message-2'],
      processedWindowSize: 1,
    });

    assert.deepEqual(finalized.pending.map((message) => message.id), [
      'message-3',
    ]);
    assert.deepEqual(finalized.processing, []);
    // processedWindowSize caps at 1 — only the most recently finalized survives.
    assert.deepEqual(finalized.processed.map((message) => message.id), [
      'message-2',
    ]);
  });

  test('finalizing an id already evicted from processing (e.g. by a concurrent flow) is a harmless no-op', async (t) => {
    const root = await makeTempWorkspace(t);

    await appendMessageToThreadWindow({
      spaceId: 'space-1',
      explicitRoot: root,
      message: { id: 'message-1', text: 'Message 1' },
    });

    // Nothing was ever flushed into `processing` for 'message-1' — finalizing
    // it anyway must not throw or fabricate a processed entry.
    const finalized = await finalizeProcessingMessages({
      spaceId: 'space-1',
      explicitRoot: root,
      threadKey: MAIN_THREAD_KEY,
      messageIds: ['message-1'],
    });

    assert.deepEqual(finalized.processed, []);
  });
});

// Category: phase-6 concurrency design, layer 1 — threads.json is one file
// per SPACE (not per thread), so mutators for *different* threads still
// share the file and need the internal per-space store-write lock
// (flow/keyed-lock.js) to avoid a lost update. These tests exercise that
// lock indirectly, through the public threads-store API, with real
// concurrent (not sequential-await) calls.
describe('threads-store — concurrent writers to the shared per-space file', () => {
  test('two concurrent appends for different threads in the same space both survive', async (t) => {
    const root = await makeTempWorkspace(t);

    // Fired without awaiting between them — genuinely concurrent from the
    // caller's perspective, racing on the same threads.json.
    const [resultA, resultB] = await Promise.all([
      appendMessageToThreadWindow({
        spaceId: 'space-1',
        explicitRoot: root,
        message: { id: 'root-a', text: 'starts thread A' },
      }),
      appendMessageToThreadWindow({
        spaceId: 'space-1',
        explicitRoot: root,
        message: { id: 'root-b', text: 'starts thread B', parentId: 'other-root' },
      }),
    ]);

    assert.equal(resultA.threadKey, MAIN_THREAD_KEY);
    assert.equal(resultB.threadKey, 'other-root');

    const threads = await getThreads({ spaceId: 'space-1', explicitRoot: root });
    const threadKeys = threads.map((thread) => thread.key).sort();
    assert.deepEqual(threadKeys, [MAIN_THREAD_KEY, 'other-root'].sort());

    const mainThread = await getThread({
      spaceId: 'space-1',
      explicitRoot: root,
      threadKey: MAIN_THREAD_KEY,
    });
    assert.deepEqual(mainThread.pending.map((m) => m.id), ['root-a']);
  });

  test('a burst of concurrent appends across many threads in one space loses none of them', async (t) => {
    const root = await makeTempWorkspace(t);

    const THREAD_COUNT = 8;
    await Promise.all(
      Array.from({ length: THREAD_COUNT }, (_, index) =>
        appendMessageToThreadWindow({
          spaceId: 'space-1',
          explicitRoot: root,
          message: {
            id: `msg-${index}`,
            text: `message ${index}`,
            parentId: index === 0 ? undefined : `root-${index}`,
          },
        })
      )
    );

    const threads = await getThreads({ spaceId: 'space-1', explicitRoot: root, limit: 100 });
    assert.equal(threads.length, THREAD_COUNT);

    const allPendingIds = threads.flatMap((thread) => thread.pending.map((m) => m.id));
    assert.equal(allPendingIds.length, THREAD_COUNT);
  });
});

// Atomic writes (phase 6) — a reader concurrent with a write must never see
// a torn/partial JSON file. writeThreadsState now writes-temp-then-renames
// (storage/atomic-write.js) instead of writing the target file in place.
describe('threads-store — atomic writes', () => {
  test('a read racing many concurrent writes never observes a corrupt file', async (t) => {
    const root = await makeTempWorkspace(t);

    await appendMessageToThreadWindow({
      spaceId: 'space-1',
      explicitRoot: root,
      message: { id: 'seed', text: 'seed message' },
    });

    const WRITE_COUNT = 20;
    const writes = Array.from({ length: WRITE_COUNT }, (_, index) =>
      appendMessageToThreadWindow({
        spaceId: 'space-1',
        explicitRoot: root,
        message: { id: `burst-${index}`, text: `burst ${index}` },
      })
    );

    // Interleave reads with the in-flight writes — readThreadsState does a
    // bare fs.readFile + JSON.parse with no lock; it must never throw on a
    // half-written file.
    const reads = Array.from({ length: WRITE_COUNT }, () =>
      getThread({ spaceId: 'space-1', explicitRoot: root, threadKey: MAIN_THREAD_KEY })
    );

    const results = await Promise.all([...writes, ...reads]);
    // Every read call resolved to a thread record (never rejected with a
    // JSON.parse error) — asserting on the shape is enough to prove no read
    // ever saw a torn file.
    for (const result of results) {
      assert.ok(result && typeof result === 'object');
    }

    const finalThread = await getThread({
      spaceId: 'space-1',
      explicitRoot: root,
      threadKey: MAIN_THREAD_KEY,
    });
    assert.equal(finalThread.pending.length, WRITE_COUNT + 1);
  });
});

// Category: Active space configuration persistence.
// These tests verify a missing configuration is explicit and a submitted configuration is stored with source audit metadata.
describe('active configuration store', () => {
  test('writes and reads the active configuration record', async (t) => {
    const root = await makeTempWorkspace(t);
    assert.equal(await readActiveConfig({ spaceId: 'space-1', explicitRoot: root }), null);

    const written = await writeActiveConfig({
      spaceId: 'space-1',
      explicitRoot: root,
      config: { projectName: 'Project', proactivityThreshold: 0.7 },
      source: { submittedBy: 'person-1' },
    });
    const read = await readActiveConfig({ spaceId: 'space-1', explicitRoot: root });

    assert.equal(written.revision, 1);
    assert.deepEqual(read.config, { projectName: 'Project', proactivityThreshold: 0.7 });
    assert.deepEqual(read.source, { submittedBy: 'person-1' });
  });

  // config card consolidation: membership cache lives in the same active.json
  // record but through its own narrower write path, so a passive refresh
  // never bumps revision/source the way a deliberate user submission does.
  test('writeCachedMembers updates the member cache without touching revision or config', async (t) => {
    const root = await makeTempWorkspace(t);

    const written = await writeActiveConfig({
      spaceId: 'space-1',
      explicitRoot: root,
      config: { projectName: 'Project' },
      source: { submittedBy: 'person-1' },
    });
    assert.equal(written.revision, 1);

    const members = [{ id: 'person-1', email: 'alice@example.com', name: 'Alice', source: 'webex' }];
    const cached = await writeCachedMembers({ spaceId: 'space-1', explicitRoot: root, members });

    assert.deepEqual(cached.members, members);
    assert.equal(cached.revision, 1);
    assert.deepEqual(cached.config, { projectName: 'Project' });
    assert.deepEqual(cached.source, { submittedBy: 'person-1' });

    const read = await readActiveConfig({ spaceId: 'space-1', explicitRoot: root });
    assert.deepEqual(read.members, members);
    assert.equal(read.revision, 1);

    // A later real submission still bumps revision independently of the
    // member cache having been written in between.
    const resubmitted = await writeActiveConfig({
      spaceId: 'space-1',
      explicitRoot: root,
      config: { projectName: 'Project Renamed' },
      source: { submittedBy: 'person-1' },
    });
    assert.equal(resubmitted.revision, 2);
    assert.deepEqual(resubmitted.members, members);
  });

  test('writeCachedMembers requires a spaceId and a members array', async (t) => {
    const root = await makeTempWorkspace(t);
    await assert.rejects(
      writeCachedMembers({ members: [], explicitRoot: root }),
      /spaceId is required/
    );
    await assert.rejects(
      writeCachedMembers({ spaceId: 'space-1', explicitRoot: root }),
      /members array is required/
    );
  });
});

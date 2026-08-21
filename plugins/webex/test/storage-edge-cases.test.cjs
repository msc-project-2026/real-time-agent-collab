'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { describe, test } = require('node:test');

const {
  getWorkspaceRoot,
  pendingBatchStatePath,
  processingBatchPath,
  conversationsPath,
  itemsPath,
  threadsPath,
  activeConfigPath,
} = require('../storage/paths');
const { readPendingBatchState } = require('../batch/state');
const { appendPendingMessage } = require('../batch/append');
const { stagePendingBatch } = require('../batch/stage');
const { loadProcessingBatch } = require('../batch/load');
const { completeProcessingBatch } = require('../batch/complete');
const {
  MAIN_THREAD_KEY,
  appendMessageToThreadWindow,
  getThread,
  getThreads,
} = require('../context/threads-store');
const {
  readConversationsState,
  writeConversationsState,
  getConversations,
} = require('../context/conversations-store');
const {
  readItemsState,
  writeItemsState,
  getCandidateItems,
  getItems,
} = require('../context/items-store');
const { readActiveConfig, writeActiveConfig } = require('../config/store');
const { makeLog, makeTempWorkspace, mockCalls } = require('./helpers.cjs');

async function writeMalformed(filePath) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, '{not json', 'utf8');
}

// Category: Storage input contracts.
// These tests ensure invalid logical identifiers are rejected before touching disk,
// so callers receive stable domain errors instead of incidental filesystem errors.
describe('storage input contracts', () => {
  test('rejects missing batch identifiers and payloads', async () => {
    await assert.rejects(appendPendingMessage({ message: {} }), /spaceId is required/);
    await assert.rejects(
      appendPendingMessage({ spaceId: 'space-1' }),
      /message is required/
    );
    await assert.rejects(stagePendingBatch({}), /spaceId is required/);
    await assert.rejects(
      loadProcessingBatch({ batchId: 'batch-1' }),
      /spaceId is required/
    );
    await assert.rejects(
      loadProcessingBatch({ spaceId: 'space-1' }),
      /batchId is required/
    );
    await assert.rejects(
      completeProcessingBatch({ batchId: 'batch-1' }),
      /spaceId is required/
    );
    await assert.rejects(
      completeProcessingBatch({ spaceId: 'space-1' }),
      /batchId is required/
    );
    await assert.rejects(readPendingBatchState(), /spaceId is required/);
  });

  test('rejects missing context and configuration inputs', async () => {
    await assert.rejects(readConversationsState(), /spaceId is required/);
    await assert.rejects(writeConversationsState({ spaceId: 'space-1' }), /state object is required/);
    await assert.rejects(getConversations(), /spaceId is required/);
    await assert.rejects(readItemsState(), /spaceId is required/);
    await assert.rejects(writeItemsState({ spaceId: 'space-1' }), /state object is required/);
    await assert.rejects(getCandidateItems(), /spaceId is required/);
    await assert.rejects(getItems(), /spaceId is required/);
    await assert.rejects(getThread(), /spaceId is required/);
    await assert.rejects(getThreads(), /spaceId is required/);
    await assert.rejects(
      appendMessageToThreadWindow({ message: { id: 'message-1' } }),
      /spaceId is required/
    );
    await assert.rejects(
      appendMessageToThreadWindow({ spaceId: 'space-1' }),
      /message\.id is required/
    );
    await assert.rejects(readActiveConfig({}), /spaceId is required/);
    await assert.rejects(
      writeActiveConfig({ spaceId: 'space-1' }),
      /config object is required/
    );
  });

  test('prefers explicit workspace roots over the environment', () => {
    const previous = process.env.OPENCLAW_WORKSPACE_DIR;
    process.env.OPENCLAW_WORKSPACE_DIR = '/environment-root';
    try {
      assert.equal(getWorkspaceRoot('/explicit-root'), '/explicit-root');
      assert.equal(getWorkspaceRoot(), '/environment-root');
    } finally {
      if (previous === undefined) delete process.env.OPENCLAW_WORKSPACE_DIR;
      else process.env.OPENCLAW_WORKSPACE_DIR = previous;
    }
  });
});

// Category: Corrupt durable state.
// These tests verify malformed persisted data is surfaced instead of silently reset,
// avoiding unnoticed context or batch loss.
describe('corrupt durable state', () => {
  test('propagates malformed JSON from every JSON state store', async (t) => {
    const root = await makeTempWorkspace(t);
    const cases = [
      [pendingBatchStatePath('space-1', root), () => readPendingBatchState('space-1', root)],
      [conversationsPath('space-1', root), () => readConversationsState({ spaceId: 'space-1', explicitRoot: root })],
      [itemsPath('space-1', root), () => readItemsState({ spaceId: 'space-1', explicitRoot: root })],
      [threadsPath('space-1', root), () => getThreads({ spaceId: 'space-1', explicitRoot: root })],
      [activeConfigPath('space-1', root), () => readActiveConfig({ spaceId: 'space-1', explicitRoot: root })],
    ];

    for (const [filePath, read] of cases) {
      await writeMalformed(filePath);
      await assert.rejects(read(), SyntaxError);
    }
  });

  test('rejects malformed JSONL processing batches', async (t) => {
    const root = await makeTempWorkspace(t);
    const batchPath = processingBatchPath('space-1', 'batch-1', root);
    await fs.mkdir(path.dirname(batchPath), { recursive: true });
    await fs.writeFile(batchPath, '{"id":"message-1"}\n{bad\n', 'utf8');

    await assert.rejects(
      loadProcessingBatch({
        spaceId: 'space-1',
        batchId: 'batch-1',
        explicitRoot: root,
      }),
      SyntaxError
    );
  });
});

// Category: Context state defaults and filtering.
// These tests verify malformed in-memory collection shapes are normalised on write,
// missing threads have a stable shape, and empty filters do not accidentally hide data.
describe('context state defaults and filtering', () => {
  test('normalises invalid persisted collection shapes to empty arrays', async (t) => {
    const root = await makeTempWorkspace(t);
    const conversations = await writeConversationsState({
      spaceId: 'space-1',
      explicitRoot: root,
      state: { schemaVersion: null, conversations: 'invalid', updatedAt: null },
    });
    const items = await writeItemsState({
      spaceId: 'space-1',
      explicitRoot: root,
      state: { schemaVersion: null, items: {}, updatedAt: null },
    });

    assert.deepEqual(conversations.conversations, []);
    assert.deepEqual(items.items, []);
    assert.equal(conversations.schemaVersion, 1);
    assert.equal(items.schemaVersion, 1);
    assert.match(conversations.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.match(items.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
  });

  test('returns a stable missing-thread record and treats empty filters as unrestricted', async (t) => {
    const root = await makeTempWorkspace(t);
    const missingMain = await getThread({
      spaceId: 'space-1',
      explicitRoot: root,
      threadKey: MAIN_THREAD_KEY,
    });
    const missingReply = await getThread({
      spaceId: 'space-1',
      explicitRoot: root,
      threadKey: 'root-1',
    });
    assert.deepEqual(missingMain, {
      key: MAIN_THREAD_KEY,
      kind: 'main',
      rootMessageId: null,
      contextWindow: [],
      pending: [],
      processed: [],
      updatedAt: null,
    });
    assert.equal(missingReply.kind, 'webex_thread');
    assert.equal(missingReply.rootMessageId, 'root-1');

    await writeConversationsState({
      spaceId: 'space-1',
      explicitRoot: root,
      state: { conversations: [{ id: 'conv-1', status: 'closed' }] },
    });
    await writeItemsState({
      spaceId: 'space-1',
      explicitRoot: root,
      state: { items: [{ id: 'item-1', status: 'stale', type: 'risk' }] },
    });
    assert.equal(
      (await getConversations({ spaceId: 'space-1', explicitRoot: root, statuses: [] })).length,
      1
    );
    assert.equal(
      (await getItems({
        spaceId: 'space-1',
        explicitRoot: root,
        statuses: [],
        types: [],
        conversationIds: [],
      })).length,
      1
    );
  });

  test('orders unfiltered item and thread collections by most recent activity', async (t) => {
    const root = await makeTempWorkspace(t);
    await writeItemsState({
      spaceId: 'space-1',
      explicitRoot: root,
      state: {
        items: [
          { id: 'old', createdAt: '2026-01-01T00:00:00.000Z' },
          { id: 'new', updatedAt: '2026-01-02T00:00:00.000Z' },
        ],
      },
    });
    await appendMessageToThreadWindow({
      spaceId: 'space-1',
      explicitRoot: root,
      message: { id: 'main-message' },
    });
    await new Promise((resolve) => setTimeout(resolve, 2));
    await appendMessageToThreadWindow({
      spaceId: 'space-1',
      explicitRoot: root,
      message: { id: 'reply-message', parentId: 'root-1' },
    });

    assert.deepEqual(
      (await getItems({ spaceId: 'space-1', explicitRoot: root })).map((item) => item.id),
      ['new', 'old']
    );
    assert.deepEqual(
      (await getThreads({ spaceId: 'space-1', explicitRoot: root })).map((thread) => thread.key),
      ['root-1', MAIN_THREAD_KEY]
    );
  });

  test('keeps a reply when root seeding returns invalid data or fails', async (t) => {
    const root = await makeTempWorkspace(t);
    const log = makeLog(t);
    const fetchMessageById = t.mock.fn(async (id) => {
      if (id === 'root-invalid') return { text: 'missing id' };
      throw new Error('root lookup unavailable');
    });

    for (const rootId of ['root-invalid', 'root-error']) {
      await appendMessageToThreadWindow({
        spaceId: 'space-1',
        explicitRoot: root,
        message: { id: `reply-${rootId}`, parentId: rootId, text: 'Reply' },
        fetchMessageById,
        log,
      });
      const thread = await getThread({
        spaceId: 'space-1',
        explicitRoot: root,
        threadKey: rootId,
      });
      assert.deepEqual(thread.contextWindow.map((message) => message.id), [
        `reply-${rootId}`,
      ]);
    }
    assert.ok(
      mockCalls(log.warn).some(([text]) => text.includes('returned invalid message'))
    );
    assert.ok(
      mockCalls(log.warn).some(([text]) => text.includes('root lookup unavailable'))
    );
  });
});

// Category: Configuration revision history.
// This regression test verifies repeated saves advance the durable revision and
// preserve the explicit absence of source metadata.
describe('configuration revision history', () => {
  test('increments revisions across repeated writes', async (t) => {
    const root = await makeTempWorkspace(t);
    const first = await writeActiveConfig({
      spaceId: 'space-1',
      explicitRoot: root,
      config: { projectName: 'First' },
    });
    const second = await writeActiveConfig({
      spaceId: 'space-1',
      explicitRoot: root,
      config: { projectName: 'Second' },
      source: { submittedBy: 'person-1' },
    });

    assert.equal(first.revision, 1);
    assert.equal(first.source, null);
    assert.equal(second.revision, 2);
    assert.deepEqual(second.source, { submittedBy: 'person-1' });
    assert.equal(
      (await readActiveConfig({ spaceId: 'space-1', explicitRoot: root })).revision,
      2
    );
  });
});

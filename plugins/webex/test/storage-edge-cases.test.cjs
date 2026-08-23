'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { describe, test } = require('node:test');

const {
  getWorkspaceRoot,
  threadsPath,
  activeConfigPath,
} = require('../storage/paths');
const {
  MAIN_THREAD_KEY,
  appendMessageToThreadWindow,
  getThread,
  getThreads,
} = require('../storage/threads-store');
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
  test('rejects missing context and configuration inputs', async () => {
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
// avoiding unnoticed context loss.
describe('corrupt durable state', () => {
  test('propagates malformed JSON from every JSON state store', async (t) => {
    const root = await makeTempWorkspace(t);
    const cases = [
      [threadsPath('space-1', root), () => getThreads({ spaceId: 'space-1', explicitRoot: root })],
      [activeConfigPath('space-1', root), () => readActiveConfig({ spaceId: 'space-1', explicitRoot: root })],
    ];

    for (const [filePath, read] of cases) {
      await writeMalformed(filePath);
      await assert.rejects(read(), SyntaxError);
    }
  });
});

// Category: Context state defaults and filtering.
// These tests verify missing threads have a stable shape and root-seeding
// failures don't drop the triggering reply.
describe('context state defaults and filtering', () => {
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
      pending: [],
      processing: [],
      processed: [],
      updatedAt: null,
    });
    assert.equal(missingReply.kind, 'webex_thread');
    assert.equal(missingReply.rootMessageId, 'root-1');
  });

  test('orders unfiltered thread collections by most recent activity', async (t) => {
    const root = await makeTempWorkspace(t);
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
      // The reply survives even when root seeding fails/is invalid — it
      // still lands in pending (no personId here, so not bot-authored),
      // and no broken root entry gets added anywhere.
      assert.deepEqual(thread.pending.map((message) => message.id), [
        `reply-${rootId}`,
      ]);
      assert.deepEqual(thread.processed, []);
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

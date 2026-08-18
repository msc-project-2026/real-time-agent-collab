'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { describe, test } = require('node:test');

const {
  loadWithMocks,
  makeLog,
  makeTempWorkspace,
  mockCalls,
} = require('./helpers.cjs');

async function flushMicrotasks(rounds = 8) {
  for (let index = 0; index < rounds; index += 1) await Promise.resolve();
}

// Category: Delayed batch scheduling.
// These tests verify per-space debouncing, successful timer execution, and asynchronous handler failures without real waiting.
describe('delayed batch scheduling', () => {
  test('requires a space identifier before creating a timer', () => {
    const { schedulePendingBatchStaging } = require('../batch/schedule');
    assert.throws(
      () =>
        schedulePendingBatchStaging({
          account: { accountId: 'default' },
          batchStagingHandler: () => undefined,
        }),
      /spaceId is required/
    );
  });

  test('replaces a prior timer and invokes only the latest handler', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { schedulePendingBatchStaging } = require('../batch/schedule');
    const firstHandler = t.mock.fn(async () => undefined);
    const secondHandler = t.mock.fn(async () => undefined);
    const log = makeLog(t);
    const account = { accountId: 'default' };

    schedulePendingBatchStaging({
      spaceId: 'space-debounce',
      account,
      log,
      batchStagingHandler: firstHandler,
    });
    schedulePendingBatchStaging({
      spaceId: 'space-debounce',
      account,
      log,
      batchStagingHandler: secondHandler,
    });

    t.mock.timers.tick(29_999);
    assert.equal(secondHandler.mock.callCount(), 0);
    t.mock.timers.tick(1);
    await flushMicrotasks();

    assert.equal(firstHandler.mock.callCount(), 0);
    assert.equal(secondHandler.mock.callCount(), 1);
    assert.deepEqual(secondHandler.mock.calls[0].arguments[0], {
      spaceId: 'space-debounce',
      account,
      log,
    });
  });

  test('logs a rejected timer handler and keeps the scheduler usable', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const loaded = loadWithMocks(require.resolve('../batch/schedule'));
    t.after(loaded.restore);
    const log = makeLog(t);
    const failure = t.mock.fn(async () => {
      throw new Error('stage failed');
    });

    loaded.subject.schedulePendingBatchStaging({
      spaceId: 'space-failure',
      account: { accountId: 'default' },
      log,
      batchStagingHandler: failure,
    });
    t.mock.timers.tick(30_000);
    await flushMicrotasks();

    assert.equal(failure.mock.callCount(), 1);
    assert.ok(mockCalls(log.error).some(([text]) => text.includes('stage failed')));
  });
});

// Category: Restart recovery scanning.
// These tests verify only overdue valid per-space states are recovered while future, malformed, missing, and non-directory entries are skipped safely.
describe('restart recovery scanning', () => {
  test('recovers only overdue valid batch states', async (t) => {
    const root = await makeTempWorkspace(t);
    const previousRoot = process.env.OPENCLAW_WORKSPACE_DIR;
    process.env.OPENCLAW_WORKSPACE_DIR = root;
    t.after(() => {
      if (previousRoot === undefined) delete process.env.OPENCLAW_WORKSPACE_DIR;
      else process.env.OPENCLAW_WORKSPACE_DIR = previousRoot;
    });

    const spacesRoot = path.join(root, '.collab', 'spaces');
    await Promise.all(
      ['overdue', 'future', 'bad-json'].map((spaceId) =>
        fs.mkdir(path.join(spacesRoot, spaceId, 'pending'), { recursive: true })
      )
    );
    await fs.writeFile(
      path.join(spacesRoot, 'overdue', 'pending', 'batch-state.json'),
      JSON.stringify({
        scheduledRunAfter: '2020-01-01T00:00:00.000Z',
        messageCount: 2,
      })
    );
    await fs.writeFile(
      path.join(spacesRoot, 'future', 'pending', 'batch-state.json'),
      JSON.stringify({
        scheduledRunAfter: '2999-01-01T00:00:00.000Z',
        messageCount: 1,
      })
    );
    await fs.writeFile(
      path.join(spacesRoot, 'bad-json', 'pending', 'batch-state.json'),
      '{bad json'
    );
    await fs.writeFile(path.join(spacesRoot, 'not-a-dir'), 'ignored');

    const loaded = loadWithMocks(require.resolve('../batch/schedule'));
    t.after(loaded.restore);
    const batchStagingHandler = t.mock.fn(async () => undefined);
    const log = makeLog(t);

    await loaded.subject.runPendingBatchStagingRecovery({
      account: { accountId: 'default' },
      log,
      batchStagingHandler,
    });

    assert.equal(batchStagingHandler.mock.callCount(), 1);
    assert.equal(batchStagingHandler.mock.calls[0].arguments[0].spaceId, 'overdue');
    assert.equal(log.warn.mock.callCount(), 1);
  });

  test('treats a missing spaces directory as an empty recovery scan', async (t) => {
    const root = await makeTempWorkspace(t);
    const previousRoot = process.env.OPENCLAW_WORKSPACE_DIR;
    process.env.OPENCLAW_WORKSPACE_DIR = root;
    t.after(() => {
      if (previousRoot === undefined) delete process.env.OPENCLAW_WORKSPACE_DIR;
      else process.env.OPENCLAW_WORKSPACE_DIR = previousRoot;
    });
    const loaded = loadWithMocks(require.resolve('../batch/schedule'));
    t.after(loaded.restore);
    const batchStagingHandler = t.mock.fn();
    const log = makeLog(t);

    await loaded.subject.runPendingBatchStagingRecovery({
      account: { accountId: 'default' },
      log,
      batchStagingHandler,
    });

    assert.equal(batchStagingHandler.mock.callCount(), 0);
    assert.ok(mockCalls(log.info).some(([text]) => text.includes('completed')));
  });

  test('warns about invalid schedules and continues after a recovered batch fails', async (t) => {
    const root = await makeTempWorkspace(t);
    const previousRoot = process.env.OPENCLAW_WORKSPACE_DIR;
    process.env.OPENCLAW_WORKSPACE_DIR = root;
    t.after(() => {
      if (previousRoot === undefined) delete process.env.OPENCLAW_WORKSPACE_DIR;
      else process.env.OPENCLAW_WORKSPACE_DIR = previousRoot;
    });
    const spacesRoot = path.join(root, '.collab', 'spaces');
    for (const spaceId of ['invalid-time', 'fails', 'succeeds']) {
      await fs.mkdir(path.join(spacesRoot, spaceId, 'pending'), { recursive: true });
      await fs.writeFile(
        path.join(spacesRoot, spaceId, 'pending', 'batch-state.json'),
        JSON.stringify({
          scheduledRunAfter:
            spaceId === 'invalid-time' ? 'not-a-date' : '2020-01-01T00:00:00.000Z',
          messageCount: 1,
        })
      );
    }
    const loaded = loadWithMocks(require.resolve('../batch/schedule'));
    t.after(loaded.restore);
    const batchStagingHandler = t.mock.fn(async ({ spaceId }) => {
      if (spaceId === 'fails') throw new Error('cannot recover batch');
    });
    const log = makeLog(t);

    await loaded.subject.runPendingBatchStagingRecovery({
      account: { accountId: 'default' },
      log,
      batchStagingHandler,
    });

    assert.deepEqual(
      batchStagingHandler.mock.calls.map((call) => call.arguments[0].spaceId),
      ['fails', 'succeeds']
    );
    assert.ok(
      mockCalls(log.warn).some(([text]) => text.includes('invalid scheduledRunAfter'))
    );
    assert.ok(
      mockCalls(log.error).some(([, details]) =>
        details?.error?.includes('cannot recover batch')
      )
    );
  });

  test('contains unexpected recovery scan failures at the run boundary', async (t) => {
    const root = await makeTempWorkspace(t);
    const previousRoot = process.env.OPENCLAW_WORKSPACE_DIR;
    process.env.OPENCLAW_WORKSPACE_DIR = root;
    t.after(() => {
      if (previousRoot === undefined) delete process.env.OPENCLAW_WORKSPACE_DIR;
      else process.env.OPENCLAW_WORKSPACE_DIR = previousRoot;
    });
    await fs.mkdir(path.join(root, '.collab'), { recursive: true });
    await fs.writeFile(path.join(root, '.collab', 'spaces'), 'not a directory');
    const loaded = loadWithMocks(require.resolve('../batch/schedule'));
    t.after(loaded.restore);
    const log = makeLog(t);

    await loaded.subject.runPendingBatchStagingRecovery({
      log,
      batchStagingHandler: t.mock.fn(),
    });

    assert.ok(
      mockCalls(log.error).some(([text]) =>
        text.includes('[webex:default] pending batch recovery scan failed')
      )
    );
  });
});

function loadDispatch(t) {
  const loaded = loadWithMocks(require.resolve('../dispatch'));
  t.after(loaded.restore);
  return loaded.subject;
}

function dispatchContext(t, dispatch, overrides = {}) {
  return {
    pluginRuntime: {
      config: { current: () => ({ agents: { defaults: {} } }) },
      channel: {
        reply: { dispatchReplyWithBufferedBlockDispatcher: dispatch },
      },
    },
    queueKey: 'space-1:routing',
    account: { accountId: 'default' },
    log: makeLog(t),
    buildCtxPayload: t.mock.fn((suffix) => ({
      SessionKey: suffix ? `canonical:${suffix}` : 'canonical',
    })),
    onAgentOutput: t.mock.fn(async () => undefined),
    ...overrides,
  };
}

async function finishSingleDispatch(t, promise) {
  await flushMicrotasks();
  t.mock.timers.tick(500);
  await flushMicrotasks();
  return promise;
}

// Category: Dispatch availability and payload delivery.
// These tests verify missing runtime support is non-fatal and successful dispatch uses loaded configuration, filters empty output, and forwards errors.
describe('dispatch availability and payload delivery', () => {
  test('warns and returns when the OpenClaw reply dispatcher is unavailable', async (t) => {
    const { dispatchToAgent } = loadDispatch(t);
    const log = makeLog(t);

    await dispatchToAgent({
      pluginRuntime: {},
      queueKey: 'space-1:routing',
      account: { accountId: 'default' },
      log,
      buildCtxPayload: t.mock.fn(),
      onAgentOutput: t.mock.fn(),
    });

    assert.equal(log.warn.mock.callCount(), 1);
  });

  test('dispatches context and delivers only non-empty agent output', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let options;
    const dispatch = t.mock.fn(async (value) => {
      options = value;
      await value.dispatcherOptions.deliver({});
      await value.dispatcherOptions.deliver({ text: 'agent response' });
      value.dispatcherOptions.onError(new Error('reported failure'));
    });
    const { dispatchToAgent } = loadDispatch(t);
    const context = dispatchContext(t, dispatch);

    const promise = dispatchToAgent(context);
    await finishSingleDispatch(t, promise);

    assert.deepEqual(options.ctx, { SessionKey: 'canonical' });
    assert.deepEqual(options.cfg, { agents: { defaults: {} } });
    assert.deepEqual(options.replyOptions, {});
    assert.equal(context.onAgentOutput.mock.callCount(), 1);
    assert.equal(context.onAgentOutput.mock.calls[0].arguments[0].text, 'agent response');
    assert.ok(mockCalls(context.log.error).some(([text]) => text.includes('reported failure')));
  });

  test('logs a rejected asynchronous output handler', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const dispatch = t.mock.fn(async (options) => {
      await options.dispatcherOptions.deliver({ text: 'agent response' });
    });
    const { dispatchToAgent } = loadDispatch(t);
    const context = dispatchContext(t, dispatch, {
      onAgentOutput: t.mock.fn(async () => {
        throw new Error('output failed');
      }),
    });

    const promise = dispatchToAgent(context);
    await finishSingleDispatch(t, promise);
    await flushMicrotasks();

    assert.ok(mockCalls(context.log.error).some(([text]) => text.includes('output failed')));
  });

  test('calls onJobCompletion when dispatch resolves', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    // Simulates a tool-only session: dispatch resolves without any deliver calls.
    const dispatch = t.mock.fn(async () => undefined);
    const { dispatchToAgent } = loadDispatch(t);
    const onJobCompletion = t.mock.fn(async () => undefined);
    const context = dispatchContext(t, dispatch, { onJobCompletion });

    const promise = dispatchToAgent(context);
    await finishSingleDispatch(t, promise);
    await flushMicrotasks();

    assert.equal(onJobCompletion.mock.callCount(), 1);
    assert.equal(context.onAgentOutput.mock.callCount(), 0);
  });

  test('fires onJobCompletion exactly once regardless of deliver call count', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const dispatch = t.mock.fn(async (options) => {
      await options.dispatcherOptions.deliver({});
      await options.dispatcherOptions.deliver({ text: 'output' });
    });
    const { dispatchToAgent } = loadDispatch(t);
    const onJobCompletion = t.mock.fn(async () => undefined);
    const context = dispatchContext(t, dispatch, { onJobCompletion });

    const promise = dispatchToAgent(context);
    await finishSingleDispatch(t, promise);
    await flushMicrotasks();

    // dispatch() resolves once → onJobCompletion fires once, regardless of deliver call count
    assert.equal(onJobCompletion.mock.callCount(), 1);
  });

  test('logs a rejected onJobCompletion handler without propagating', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const dispatch = t.mock.fn(async () => undefined);
    const { dispatchToAgent } = loadDispatch(t);
    const context = dispatchContext(t, dispatch, {
      onJobCompletion: t.mock.fn(async () => {
        throw new Error('session complete failed');
      }),
    });

    const promise = dispatchToAgent(context);
    await finishSingleDispatch(t, promise);
    await flushMicrotasks();

    assert.ok(
      mockCalls(context.log.error).some(([text]) => text.includes('session complete failed'))
    );
  });
});

// Category: Session-conflict recovery.
// These tests verify only the known transient initialization conflict retries, with a temporary recovery key and a single retry.
describe('session-conflict recovery', () => {
  test('retries one transient session conflict with a recovery suffix', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let attempts = 0;
    const dispatch = t.mock.fn(async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error('reply session initialization conflicted with existing session');
      }
    });
    const { dispatchToAgent } = loadDispatch(t);
    const context = dispatchContext(t, dispatch);

    const promise = dispatchToAgent(context);
    await flushMicrotasks();
    assert.equal(dispatch.mock.callCount(), 1);
    t.mock.timers.tick(500);
    await flushMicrotasks();
    assert.equal(dispatch.mock.callCount(), 2);
    t.mock.timers.tick(500);
    await flushMicrotasks();
    await promise;

    assert.equal(context.buildCtxPayload.mock.callCount(), 2);
    assert.equal(context.buildCtxPayload.mock.calls[0].arguments[0], undefined);
    assert.match(context.buildCtxPayload.mock.calls[1].arguments[0], /^recovery-\d+$/);
  });

  test('propagates unrelated dispatch failures without retrying', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const dispatch = t.mock.fn(async () => {
      throw new Error('permission denied');
    });
    const { dispatchToAgent } = loadDispatch(t);
    const context = dispatchContext(t, dispatch);

    const promise = dispatchToAgent(context);
    await flushMicrotasks();
    t.mock.timers.tick(500);
    await flushMicrotasks();

    await assert.rejects(promise, /permission denied/);
    assert.equal(dispatch.mock.callCount(), 1);
  });
});

// Category: Per-session dispatch ordering.
// These tests verify jobs sharing the same queue key are serialised while independent
// queue keys (different spaces or different session types) can start concurrently.
describe('per-session dispatch ordering', () => {
  test('waits for the prior same-queue settle delay before starting the next job', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const starts = [];
    const dispatch = t.mock.fn(async (options) => {
      starts.push(options.ctx.SessionKey);
    });
    const { dispatchToAgent } = loadDispatch(t);
    const first = dispatchContext(t, dispatch, {
      buildCtxPayload: () => ({ SessionKey: 'first' }),
    });
    const second = dispatchContext(t, dispatch, {
      buildCtxPayload: () => ({ SessionKey: 'second' }),
    });

    const firstPromise = dispatchToAgent(first);
    const secondPromise = dispatchToAgent(second);
    await flushMicrotasks();
    assert.deepEqual(starts, ['first']);

    t.mock.timers.tick(500);
    await flushMicrotasks();
    assert.deepEqual(starts, ['first', 'second']);

    t.mock.timers.tick(500);
    await flushMicrotasks();
    await Promise.all([firstPromise, secondPromise]);
  });

  test('starts jobs for different queue keys independently', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const starts = [];
    const dispatch = t.mock.fn(async (options) => {
      starts.push(options.ctx.SessionKey);
    });
    const { dispatchToAgent } = loadDispatch(t);
    const first = dispatchContext(t, dispatch, {
      queueKey: 'space-a:routing',
      buildCtxPayload: () => ({ SessionKey: 'space-a' }),
    });
    const second = dispatchContext(t, dispatch, {
      queueKey: 'space-b:routing',
      buildCtxPayload: () => ({ SessionKey: 'space-b' }),
    });

    const promises = [dispatchToAgent(first), dispatchToAgent(second)];
    await flushMicrotasks();
    assert.deepEqual(new Set(starts), new Set(['space-a', 'space-b']));

    t.mock.timers.tick(500);
    await flushMicrotasks();
    await Promise.all(promises);
  });

  test('continues a same-space queue after the previous dispatch rejects', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const warning = t.mock.method(console, 'warn', () => undefined);
    const firstDispatch = t.mock.fn(async () => {
      throw new Error('first dispatch failed');
    });
    const secondDispatch = t.mock.fn(async () => undefined);
    const { dispatchToAgent } = loadDispatch(t);
    const firstPromise = dispatchToAgent(
      dispatchContext(t, firstDispatch, {
        buildCtxPayload: () => ({ SessionKey: 'first' }),
      })
    );
    const observedFirst = firstPromise.catch((error) => error);
    const secondPromise = dispatchToAgent(
      dispatchContext(t, secondDispatch, {
        buildCtxPayload: () => ({ SessionKey: 'second' }),
      })
    );

    await flushMicrotasks();
    assert.equal(firstDispatch.mock.callCount(), 1);
    assert.equal(secondDispatch.mock.callCount(), 0);
    t.mock.timers.tick(500);
    await flushMicrotasks();
    assert.equal(secondDispatch.mock.callCount(), 1);
    assert.ok(
      warning.mock.calls.some((call) =>
        call.arguments[0].includes('previous dispatch failed; continuing queue')
      )
    );
    assert.match((await observedFirst).message, /first dispatch failed/);
    t.mock.timers.tick(500);
    await flushMicrotasks();
    await secondPromise;
  });
});

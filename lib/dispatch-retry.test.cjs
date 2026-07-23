'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { dispatchWithSessionRecovery } = require('./dispatch-retry.js');

const conflictError = () =>
  new Error(
    'reply session initialization conflicted for agent:main:webex:room-1'
  );

// Keep tests fast: same retry ladder shape, near-zero sleeps.
const FAST = { retry: { maxAttempts: 3, maxBackoffMs: 1 }, settleDelayMs: 1 };

test('dispatch succeeds on the canonical key without recovery', async () => {
  const suffixes = [];
  const result = await dispatchWithSessionRecovery(
    async (args) => args,
    (suffix) => {
      suffixes.push(suffix);
      return { suffix };
    },
    FAST
  );
  assert.deepEqual(result, { suffix: undefined });
  assert.deepEqual(suffixes, [undefined]);
});

test('transient conflicts are retried on the canonical key, not forked', async () => {
  let calls = 0;
  const result = await dispatchWithSessionRecovery(
    async (args) => {
      calls += 1;
      if (calls < 3) throw conflictError();
      return args.suffix ?? 'canonical';
    },
    (suffix) => ({ suffix }),
    FAST
  );
  assert.equal(result, 'canonical');
  assert.equal(calls, 3);
});

test('persistent conflict falls back to one recovery-key dispatch', async () => {
  const dispatched = [];
  let recovered;
  const result = await dispatchWithSessionRecovery(
    async (args) => {
      dispatched.push(args.suffix);
      if (!args.suffix) throw conflictError();
      return `sent:${args.suffix}`;
    },
    (suffix) => ({ suffix }),
    {
      ...FAST,
      onRecovery: (suffix, err) => {
        recovered = { suffix, err };
      },
    }
  );

  // All canonical attempts, then exactly one recovery attempt.
  assert.deepEqual(dispatched.slice(0, 3), [undefined, undefined, undefined]);
  assert.equal(dispatched.length, 4);
  const suffix = dispatched[3];
  assert.match(suffix, /^recovery-\d+$/);
  assert.equal(result, `sent:${suffix}`);
  assert.equal(recovered.suffix, suffix);
  assert.match(recovered.err.message, /session initialization conflicted/);
});

test('non-conflict errors are rethrown immediately without recovery', async () => {
  const dispatched = [];
  await assert.rejects(
    () =>
      dispatchWithSessionRecovery(
        async (args) => {
          dispatched.push(args.suffix);
          throw new Error('boom');
        },
        (suffix) => ({ suffix }),
        FAST
      ),
    /boom/
  );
  assert.deepEqual(dispatched, [undefined]);
});

test('a failing recovery dispatch propagates its error', async () => {
  await assert.rejects(
    () =>
      dispatchWithSessionRecovery(
        async (args) => {
          if (!args.suffix) throw conflictError();
          throw new Error('recovery also failed');
        },
        (suffix) => ({ suffix }),
        FAST
      ),
    /recovery also failed/
  );
});

'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { dispatchWithSessionRecovery } = require('./dispatch-retry');

test('retries a session-initialization conflict with the original dispatch arguments', async (t) => {
  const originalSetTimeout = global.setTimeout;
  global.setTimeout = (callback) => { callback(); return {}; };
  t.after(() => { global.setTimeout = originalSetTimeout; });
  const calls = [];
  const result = await dispatchWithSessionRecovery(
    async (args) => { calls.push(args); if (calls.length === 1) throw new Error('session initialization conflicted'); return 'sent'; },
    (suffix) => ({ suffix: suffix ?? 'primary' }),
    { retry: { maxAttempts: 3, maxBackoffMs: 1 } }
  );
  assert.equal(result, 'sent');
  assert.deepEqual(calls, [{ suffix: 'primary' }, { suffix: 'primary' }]);
});

test('uses an isolated recovery session after retries are exhausted', async (t) => {
  const originalSetTimeout = global.setTimeout;
  const originalDateNow = Date.now;
  global.setTimeout = (callback) => { callback(); return {}; };
  Date.now = () => 12345;
  t.after(() => { global.setTimeout = originalSetTimeout; Date.now = originalDateNow; });
  const attempts = [];
  const recovery = [];
  const result = await dispatchWithSessionRecovery(
    async (args) => {
      attempts.push(args);
      if (args.suffix) return 'recovered';
      throw new Error('Session initialization conflicted');
    },
    (suffix) => ({ suffix }),
    { retry: { maxAttempts: 2, maxBackoffMs: 1 }, settleDelayMs: 0, onRecovery: (...args) => recovery.push(args) }
  );
  assert.equal(result, 'recovered');
  assert.deepEqual(attempts, [{ suffix: undefined }, { suffix: undefined }, { suffix: 'recovery-12345' }]);
  assert.equal(recovery[0][0], 'recovery-12345');
});

test('does not hide a non-session error or recover from argument construction failures', async () => {
  await assert.rejects(
    dispatchWithSessionRecovery(async () => { throw new Error('permission denied'); }, () => ({})),
    /permission denied/
  );
  await assert.rejects(
    dispatchWithSessionRecovery(async () => 'unused', () => { throw new Error('invalid input'); }),
    /invalid input/
  );
});

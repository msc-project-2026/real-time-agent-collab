'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { withLock } = require('../flow/keyed-lock');

// ---------------------------------------------------------------------------
// Generic Map<key, Promise>-chain mutex (phase 6 concurrency design) — used
// for the per-thread gate+flush lock, the per-space extract lock, and the
// per-space store-write lock (context/threads-store.js). Tested here in
// isolation, independent of any of those call sites.
// ---------------------------------------------------------------------------

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('keyed-lock — withLock', () => {
  test('calls on the same key run strictly one after another (FIFO)', async () => {
    const order = [];
    const gate = deferred();

    const first = withLock('key-a', async () => {
      order.push('first-start');
      await gate.promise;
      order.push('first-end');
      return 'first-result';
    });

    const second = withLock('key-a', async () => {
      order.push('second-start');
      return 'second-result';
    });

    // `second` must not have started yet — `first` is still awaiting `gate`.
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(order, ['first-start']);

    gate.resolve();

    const [firstResult, secondResult] = await Promise.all([first, second]);

    assert.equal(firstResult, 'first-result');
    assert.equal(secondResult, 'second-result');
    assert.deepEqual(order, ['first-start', 'first-end', 'second-start']);
  });

  test('independent keys run concurrently, never block each other', async () => {
    const order = [];
    const gateA = deferred();

    const a = withLock('key-a', async () => {
      order.push('a-start');
      await gateA.promise;
      order.push('a-end');
    });

    const b = withLock('key-b', async () => {
      order.push('b-start');
      order.push('b-end');
    });

    // `b` (a different key) completes even while `a` is still blocked.
    await b;
    assert.deepEqual(order, ['a-start', 'b-start', 'b-end']);

    gateA.resolve();
    await a;
    assert.deepEqual(order, ['a-start', 'b-start', 'b-end', 'a-end']);
  });

  test('a rejected fn does not wedge the queue for the next caller on the same key', async () => {
    const first = withLock('key-c', async () => {
      throw new Error('first call fails');
    });

    await assert.rejects(first, /first call fails/);

    // The queue must still be usable afterward.
    const second = await withLock('key-c', async () => 'still works');
    assert.equal(second, 'still works');
  });

  test('a synchronously-thrown fn does not wedge the queue either', async () => {
    const first = withLock('key-d', () => {
      throw new Error('sync throw');
    });

    await assert.rejects(first, /sync throw/);

    const second = await withLock('key-d', async () => 'recovered');
    assert.equal(second, 'recovered');
  });

  test('many queued calls on one key preserve submission order end to end', async () => {
    const order = [];
    const calls = [];

    for (let i = 0; i < 5; i += 1) {
      calls.push(
        withLock('key-e', async () => {
          order.push(i);
        })
      );
    }

    await Promise.all(calls);
    assert.deepEqual(order, [0, 1, 2, 3, 4]);
  });
});

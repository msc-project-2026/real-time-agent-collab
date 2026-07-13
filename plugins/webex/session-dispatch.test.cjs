"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { enqueueSessionDispatch } = require("./session-dispatch");

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("serializes dispatches for the same session in FIFO order", async () => {
  const releaseFirst = deferred();
  const firstStarted = deferred();
  const events = [];
  let active = 0;
  let maxActive = 0;

  const first = enqueueSessionDispatch("room-1", async () => {
    events.push("first:start");
    firstStarted.resolve();
    active += 1;
    maxActive = Math.max(maxActive, active);
    await releaseFirst.promise;
    active -= 1;
    events.push("first:end");
  });
  const second = enqueueSessionDispatch("room-1", async () => {
    events.push("second:start");
    active += 1;
    maxActive = Math.max(maxActive, active);
    active -= 1;
    events.push("second:end");
  });

  await firstStarted.promise;
  assert.deepEqual(events, ["first:start"]);
  releaseFirst.resolve();
  await Promise.all([first, second]);

  assert.equal(maxActive, 1);
  assert.deepEqual(events, [
    "first:start",
    "first:end",
    "second:start",
    "second:end",
  ]);
});

test("allows different sessions to dispatch concurrently", async () => {
  const release = deferred();
  const started = deferred();
  let active = 0;

  const job = () => async () => {
    active += 1;
    if (active === 2) started.resolve();
    await release.promise;
    active -= 1;
  };

  const first = enqueueSessionDispatch("room-a", job());
  const second = enqueueSessionDispatch("room-b", job());

  await started.promise;
  assert.equal(active, 2);
  release.resolve();
  await Promise.all([first, second]);
});

test("continues a session queue after a failed dispatch", async () => {
  const expected = new Error("dispatch failed");
  const first = enqueueSessionDispatch("room-failure", async () => {
    throw expected;
  });
  const second = enqueueSessionDispatch(
    "room-failure",
    async () => "delivered",
  );

  await assert.rejects(first, expected);
  assert.equal(await second, "delivered");
});

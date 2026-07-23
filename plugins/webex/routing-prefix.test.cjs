'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { extractRoutingPrefix } = require('./routing-prefix.js');

test('strips a full routing prefix and returns only the reply (reported bug)', () => {
  const raw =
    '{"route":"append_and_process","reason":"isDirectlyAddressed is true; user is directly addressing the agent","claimedBatch":{"batchId":"2026-07-23T14-48-22-781Z-9428f6cf","messageCount":1}}\n\n' +
    'Alive and kicking! 👋 What do you need?';
  const { route, reply } = extractRoutingPrefix(raw);
  assert.equal(route, 'append_and_process');
  assert.equal(reply, 'Alive and kicking! 👋 What do you need?');
});

test('nested objects do not fool the brace walk', () => {
  const raw = '{"route":"append_only","reason":"x","claimedBatch":{"batchId":null,"messageCount":0}}\nhello';
  const { route, reply } = extractRoutingPrefix(raw);
  assert.equal(route, 'append_only');
  assert.equal(reply, 'hello');
});

test('braces inside the reason string are handled', () => {
  const raw = '{"route":"ignore","reason":"contains { and } braces"}\nkept';
  const { route, reply } = extractRoutingPrefix(raw);
  assert.equal(route, 'ignore');
  assert.equal(reply, 'kept');
});

test('a plain reply with no prefix is returned verbatim', () => {
  const { route, reply } = extractRoutingPrefix('Just a normal answer.');
  assert.equal(route, null);
  assert.equal(reply, 'Just a normal answer.');
});

test('routing-only output produces no reply', () => {
  const { route, reply } = extractRoutingPrefix('{"route":"append_only","reason":"chatter"}');
  assert.equal(route, 'append_only');
  assert.equal(reply, '');
});

test('a fenced routing object is stripped', () => {
  const raw = '```json\n{"route":"append_and_process","reason":"y"}\n```\nThe answer.';
  const { route, reply } = extractRoutingPrefix(raw);
  assert.equal(route, 'append_and_process');
  assert.equal(reply, 'The answer.');
});

test('a reply that is a JSON object without a route is sent verbatim', () => {
  const raw = '{"answer":42}';
  const { route, reply } = extractRoutingPrefix(raw);
  assert.equal(route, null);
  assert.equal(reply, '{"answer":42}');
});

test('a leading brace that is not valid JSON is sent verbatim', () => {
  const raw = '{ this is not json, just prose starting with a brace';
  const { route, reply } = extractRoutingPrefix(raw);
  assert.equal(route, null);
  assert.equal(reply, raw);
});

test('an unterminated leading object is never posted as a partial artifact', () => {
  const { route, reply } = extractRoutingPrefix('{"route":"append_and_process","reason":"cut off');
  assert.equal(route, null);
  assert.equal(reply, '');
});

test('null / undefined input yields an empty reply', () => {
  assert.deepEqual(extractRoutingPrefix(null), { route: null, reply: '' });
  assert.deepEqual(extractRoutingPrefix(undefined), { route: null, reply: '' });
});

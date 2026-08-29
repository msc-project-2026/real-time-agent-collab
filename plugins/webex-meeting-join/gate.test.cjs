'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { scoreMessage } = require('./gate');

const message = {
  text: 'Could you check the deployment?', senderName: 'Asha', chatType: 'direct',
  recentMessages: [{ senderName: 'Ben', text: 'The release is blocked.' }],
  botNamed: true, addressNames: ['Codex'],
};
const cfg = { url: 'https://gate.example/v1/chat', model: 'small-gate', apiKey: 'secret' };

test('does not call the gate when its configuration is incomplete', async () => {
  assert.deepEqual(await scoreMessage(message, {}), { score: 0, type: 'NONE' });
});

test('sends contextual evidence to the gate and parses a valid bounded result', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  let request;
  global.fetch = async (url, options) => {
    request = { url, options };
    return { ok: true, json: async () => ({ choices: [{ message: { content: ' clarification | 1.7 ' } }] }) };
  };

  assert.deepEqual(await scoreMessage(message, cfg), { score: 1, type: 'CLARIFICATION' });
  assert.equal(request.url, cfg.url);
  assert.equal(request.options.headers.Authorization, 'Bearer secret');
  const prompt = JSON.parse(request.options.body).messages[0].content;
  assert.match(prompt, /Recent conversation/);
  assert.match(prompt, /contains one of the assistant's names \(Codex\)/);
  assert.match(prompt, /a direct message/);
});

test('fails silent for transport, response, JSON, and classification errors', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  global.fetch = async () => { throw new Error('offline'); };
  assert.deepEqual(await scoreMessage(message, cfg), { score: 0, type: 'NONE' });
  global.fetch = async () => ({ ok: false });
  assert.deepEqual(await scoreMessage(message, cfg), { score: 0, type: 'NONE' });
  global.fetch = async () => ({ ok: true, json: async () => { throw new Error('bad JSON'); } });
  assert.deepEqual(await scoreMessage(message, cfg), { score: 0, type: 'NONE' });
  global.fetch = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: 'not a result' } }] }) });
  assert.deepEqual(await scoreMessage({ ...message, chatType: 'group', recentMessages: [], botNamed: false }, cfg), { score: 0, type: 'NONE' });
  global.fetch = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: 'MADE_UP|0.4' } }] }) });
  assert.deepEqual(await scoreMessage(message, cfg), { score: 0.4, type: 'NONE' });
});

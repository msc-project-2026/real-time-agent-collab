'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createHmac } = require('node:crypto');
const { createWebhookRouter, verifyHmac } = require('./webhook-router');

function fakeReq({ method = 'POST', url, headers = {}, body = '' }) {
  const chunks = [Buffer.from(body)];
  return {
    method,
    url,
    headers,
    [Symbol.asyncIterator]: async function* () {
      for (const c of chunks) yield c;
    },
  };
}

function fakeRes() {
  const res = {
    statusCode: 200,
    headersSent: false,
    headers: {},
    body: '',
    setHeader(k, v) {
      this.headers[k] = v;
    },
    end(b) {
      if (b) this.body = b;
      this.headersSent = true;
    },
  };
  return res;
}

test('verifyHmac accepts a valid signature and rejects a tampered one', () => {
  const secret = 'shh';
  const body = Buffer.from('{"hello":"world"}');
  const sig = createHmac('sha1', secret).update(body).digest('hex');
  assert.equal(verifyHmac(secret, body, sig), true);
  assert.equal(verifyHmac(secret, body, 'deadbeef'.repeat(5)), false);
  assert.equal(verifyHmac(secret, body, undefined), false);
  assert.equal(verifyHmac(undefined, body, undefined), true); // no secret configured — skip
});

test('router returns false for a path outside its own prefix', async () => {
  const router = createWebhookRouter({ webhookSecret: null, handlers: new Map() });
  const handled = await router(fakeReq({ url: '/webhooks/webex/default' }), fakeRes());
  assert.equal(handled, false);
});

test('router 404-equivalent (false) for an unregistered suffix under its own prefix', async () => {
  const router = createWebhookRouter({ webhookSecret: null, handlers: new Map() });
  const handled = await router(fakeReq({ url: '/webhooks/webex-meeting-join/unknown-suffix' }), fakeRes());
  assert.equal(handled, false);
});

test('router rejects a bad signature with 401 and never invokes the handler', async () => {
  let invoked = false;
  const router = createWebhookRouter({
    webhookSecret: 'shh',
    handlers: new Map([['/meetings-started', async () => { invoked = true; }]]),
  });
  const res = fakeRes();
  const handled = await router(
    fakeReq({ url: '/webhooks/webex-meeting-join/meetings-started', headers: { 'x-spark-signature': 'bad' }, body: '{}' }),
    res
  );
  assert.equal(handled, true);
  assert.equal(res.statusCode, 401);
  assert.equal(invoked, false);
});

test('router ACKs immediately with 200 then dispatches the handler asynchronously', async () => {
  let resolveHandler;
  const handlerStarted = new Promise((r) => { resolveHandler = r; });
  const router = createWebhookRouter({
    webhookSecret: null,
    handlers: new Map([['/meetings-started', async (payload) => {
      resolveHandler(payload);
    }]]),
  });
  const res = fakeRes();
  const payload = { data: { id: 'meeting-1' } };
  const handled = await router(
    fakeReq({ url: '/webhooks/webex-meeting-join/meetings-started', body: JSON.stringify(payload) }),
    res
  );
  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body, '{"ok":true}');
  assert.deepEqual(await handlerStarted, payload);
});

test('router rejects non-POST with 405', async () => {
  const router = createWebhookRouter({
    webhookSecret: null,
    handlers: new Map([['/meetings-started', async () => {}]]),
  });
  const res = fakeRes();
  const handled = await router(fakeReq({ method: 'GET', url: '/webhooks/webex-meeting-join/meetings-started' }), res);
  assert.equal(handled, true);
  assert.equal(res.statusCode, 405);
});

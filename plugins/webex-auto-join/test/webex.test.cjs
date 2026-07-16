'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createHmac } = require('node:crypto');
const { Readable } = require('node:stream');
const {
  ensureOwnedWebhooks,
  readRawBody,
  verifyWebhookSignature,
} = require('../dist/webex.cjs');
const { MeetingJoinService } = require('../dist/service.cjs');

function response(data = {}, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get() { return ''; } },
    text: async () => status === 204 ? '' : JSON.stringify(data),
  };
}

test('verifies HMAC-SHA1 against the unmodified webhook body', () => {
  const raw = Buffer.from('{"data":{"id":"meeting-1"}}');
  const signature = createHmac('sha1', 'secret').update(raw).digest('hex');
  assert.equal(verifyWebhookSignature('secret', raw, signature), true);
  assert.equal(verifyWebhookSignature('secret', Buffer.from(`${raw} `), signature), false);
  assert.equal(verifyWebhookSignature('secret', raw, 'invalid'), false);
});

test('rejects webhook bodies larger than one megabyte', async () => {
  await assert.rejects(
    readRawBody(Readable.from([Buffer.alloc(1024 * 1024 + 1)])),
    (error) => error.code === 'webhook_body_too_large'
  );
});

test('webhook registration only replaces hooks carrying plugin-owned names', async () => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? 'GET', body: init.body && JSON.parse(init.body) });
    if (String(url).includes('/webhooks?')) return response({
      items: [
        { id: 'keep', name: 'Owned One', targetUrl: 'https://host/new', resource: 'meetings', event: 'created', status: 'active' },
        { id: 'stale', name: 'Owned One', targetUrl: 'https://host/old', resource: 'meetings', event: 'created', status: 'active' },
        { id: 'foreign', name: 'Another Integration', targetUrl: 'https://elsewhere', resource: 'meetings', event: 'created', status: 'active' },
      ],
    });
    return response({}, init.method === 'DELETE' ? 204 : 200);
  };
  try {
    await ensureOwnedWebhooks('token', 'https://host/new', 'secret', [
      { name: 'Owned One', resource: 'meetings', event: 'created' },
      { name: 'Owned Two', resource: 'meetings', event: 'updated' },
    ]);
    assert.ok(calls.some((call) => call.method === 'DELETE' && call.url.endsWith('/webhooks/stale')));
    assert.ok(!calls.some((call) => call.url.includes('foreign')));
    assert.ok(calls.some((call) => call.method === 'POST' && call.body.name === 'Owned Two' && call.body.secret === 'secret'));
    assert.equal(calls.filter((call) => call.method === 'POST').length, 1);
    assert.equal(calls[0].url.endsWith('/webhooks?max=100'), true);
  } finally {
    global.fetch = originalFetch;
  }
});

test('meeting webhook registration includes explicit started and ended events', async () => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? 'GET', body: init.body && JSON.parse(init.body) });
    if (String(url).includes('/webhooks?')) return response({ items: [] });
    return response({}, init.method === 'POST' ? 201 : 200);
  };
  try {
    const service = new MeetingJoinService({}, {
      botToken: 'bot-token',
      webhookUrl: 'https://host/webhooks/webex-auto-join',
      webhookSecret: 'secret',
    }, { warn() {} });
    await service.ensureWebhooks('attendee-token');

    const meetingEvents = calls
      .filter((call) => call.method === 'POST' && call.body.resource === 'meetings')
      .map((call) => call.body.event)
      .sort();
    assert.deepEqual(meetingEvents, ['created', 'deleted', 'ended', 'started', 'updated']);
  } finally {
    global.fetch = originalFetch;
  }
});

test('valid webhooks are acknowledged before queued processing', async () => {
  const raw = Buffer.from(JSON.stringify({ resource: 'meetings', event: 'created', data: { id: 'meeting-1' } }));
  const signature = createHmac('sha1', 'hook-secret').update(raw).digest('hex');
  const service = new MeetingJoinService({}, { webhookSecret: 'hook-secret' }, { warn() {} });
  let queued = false;
  service.enqueue = () => { queued = true; };
  const req = Readable.from([raw]);
  req.method = 'POST';
  req.headers = { 'x-spark-signature': signature };
  const headers = {};
  const res = {
    statusCode: 0,
    setHeader(name, value) { headers[name] = value; },
    end(body = '') { this.body = body; },
  };

  await service.handleWebhookRoute(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body, '{"ok":true}');
  assert.equal(queued, true);
});

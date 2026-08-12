'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { specs, allSpecs, ensureWebhooks } = require('./webhook-subscriptions');

function response(status, data) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
    text: async () => JSON.stringify(data),
  };
}

const baseCfg = {
  meetingToken: 'meeting-token',
  botToken: 'bot-token',
  webhookBaseUrl: 'https://example.test/webhooks/webex-meeting-join',
};

test('meetingTranscripts/created is registered by default and can be disabled', () => {
  const enabled = specs(baseCfg);
  assert.ok(enabled.some((spec) => spec.resource === 'meetingTranscripts' && spec.event === 'created'));
  const disabled = specs({ ...baseCfg, minutesEnabled: false });
  assert.equal(disabled.some((spec) => spec.resource === 'meetingTranscripts'), false);
  // It remains in allSpecs so a stale subscription can still be removed.
  assert.equal(allSpecs({ ...baseCfg, minutesEnabled: false }).length, 4);
});

test('a missing transcript scope does not prevent the core meeting webhooks from registering', async () => {
  const originalFetch = global.fetch;
  const created = [];
  const warnings = [];
  global.fetch = async (url, opts = {}) => {
    if (opts.method === 'POST') {
      const body = JSON.parse(opts.body);
      created.push(body.resource);
      return body.resource === 'meetingTranscripts'
        ? response(403, { message: 'missing scope' })
        : response(200, { id: `${body.resource}-hook` });
    }
    return response(200, { items: [] });
  };
  try {
    await ensureWebhooks({
      ...baseCfg,
      log: { warn: (message) => warnings.push(message) },
    });
    assert.deepEqual(created, ['meetings', 'meetings', 'messages', 'meetingTranscripts']);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /meeting:transcripts_read/);
  } finally {
    global.fetch = originalFetch;
  }
});

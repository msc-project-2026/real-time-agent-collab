'use strict';

const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');
const { Readable } = require('node:stream');
const { describe, test } = require('node:test');

const { loadWithMocks, makeLog, mockCalls } = require('./helpers.cjs');

function makeResponse(t) {
  const response = {
    statusCode: null,
    headers: {},
    body: undefined,
    headersSent: false,
  };
  response.setHeader = t.mock.fn((name, value) => {
    response.headers[name] = value;
  });
  response.end = t.mock.fn((body) => {
    response.body = body;
    response.headersSent = true;
  });
  return response;
}

function makeRequest({ method = 'POST', url, body = '', headers = {} }) {
  const request = Readable.from([Buffer.from(body)]);
  request.method = method;
  request.url = url;
  request.headers = headers;
  return request;
}

async function flushMicrotasks(rounds = 12) {
  for (let index = 0; index < rounds; index += 1) await Promise.resolve();
}

// Category: Webhook path and HTTP-method handling.
// These tests verify normalised target lookup, unclaimed paths, and POST-only enforcement before request bodies are processed.
describe('webhook path and HTTP-method handling', () => {
  test('normalises paths and declines requests without a registered target', async (t) => {
    const { normPath, webhookRouter, targets } = require('../webhook/router');
    targets.clear();
    t.after(() => targets.clear());

    assert.equal(normPath(' webhooks/webex/oauth/default/ '),
      '/webhooks/webex/oauth/default');
    assert.equal(normPath(''), '/');
    const response = makeResponse(t);
    const handled = await webhookRouter(
      makeRequest({ method: 'POST', url: '/not-webex', body: '{}' }),
      response
    );
    assert.equal(handled, false);
    assert.equal(response.end.mock.callCount(), 0);
  });

  test('returns 405 for a registered target using a non-POST method', async (t) => {
    const { webhookRouter, targets } = require('../webhook/router');
    targets.clear();
    t.after(() => targets.clear());
    targets.set('/webhooks/webex/oauth/default', {
      account: { accountId: 'default', config: {} },
      handle: t.mock.fn(),
    });
    const response = makeResponse(t);

    assert.equal(
      await webhookRouter(
        makeRequest({ method: 'GET', url: '/webhooks/webex/oauth/default' }),
        response
      ),
      true
    );
    assert.equal(response.statusCode, 405);
    assert.equal(response.headers.Allow, 'POST');
  });
});

// Category: Webhook body security and parsing.
// These tests verify payload-size limits, HMAC validation over raw bytes, malformed JSON rejection, immediate acknowledgement, and asynchronous target dispatch.
describe('webhook body security and parsing', () => {
  test('rejects oversized, unsigned, and malformed payloads', async (t) => {
    const { webhookRouter, targets } = require('../webhook/router');
    targets.clear();
    t.after(() => targets.clear());
    targets.set('/webhooks/webex/oauth/default', {
      account: {
        accountId: 'default',
        config: { webhookSecret: 'secret' },
      },
      handle: t.mock.fn(),
    });

    const oversizedResponse = makeResponse(t);
    await webhookRouter(
      makeRequest({
        url: '/webhooks/webex/oauth/default',
        body: Buffer.alloc(1024 * 1024 + 1),
      }),
      oversizedResponse
    );
    assert.equal(oversizedResponse.statusCode, 413);

    const unsignedResponse = makeResponse(t);
    await webhookRouter(
      makeRequest({ url: '/webhooks/webex/oauth/default', body: '{}' }),
      unsignedResponse
    );
    assert.equal(unsignedResponse.statusCode, 401);

    const malformed = '{bad json';
    const signature = createHmac('sha1', 'secret').update(malformed).digest('hex');
    const malformedResponse = makeResponse(t);
    await webhookRouter(
      makeRequest({
        url: '/webhooks/webex/oauth/default',
        body: malformed,
        headers: { 'x-spark-signature': signature },
      }),
      malformedResponse
    );
    assert.equal(malformedResponse.statusCode, 400);
  });

  test('acknowledges valid signed JSON and dispatches the parsed payload', async (t) => {
    const { webhookRouter, targets } = require('../webhook/router');
    targets.clear();
    t.after(() => targets.clear());
    const handle = t.mock.fn(async () => undefined);
    targets.set('/webhooks/webex/oauth/default', {
      account: {
        accountId: 'default',
        config: { webhookSecret: 'secret' },
      },
      handle,
    });
    const body = JSON.stringify({ resource: 'messages', event: 'created' });
    const signature = createHmac('sha1', 'secret').update(body).digest('hex');
    const response = makeResponse(t);

    const handled = await webhookRouter(
      makeRequest({
        url: '/webhooks/webex/oauth/default/',
        body,
        headers: { 'x-spark-signature': signature },
      }),
      response
    );
    await Promise.resolve();

    assert.equal(handled, true);
    assert.equal(response.statusCode, 200);
    assert.equal(response.body, '{"ok":true}');
    assert.equal(handle.mock.callCount(), 1);
    assert.deepEqual(handle.mock.calls[0].arguments[0], {
      resource: 'messages',
      event: 'created',
    });
  });

  test('accepts unsigned bodies only when verification is disabled', async (t) => {
    const { webhookRouter, targets } = require('../webhook/router');
    targets.clear();
    t.after(() => targets.clear());
    const handle = t.mock.fn(async () => undefined);
    targets.set('/webhooks/webex/oauth/default', {
      account: { accountId: 'default', config: {} },
      handle,
    });
    const response = makeResponse(t);

    await webhookRouter(
      makeRequest({
        url: '/webhooks/webex/oauth/default',
        body: '{"id":"hook-1"}',
      }),
      response
    );
    await flushMicrotasks();

    assert.equal(response.statusCode, 200);
    assert.equal(handle.mock.callCount(), 1);
  });

  test('rejects malformed signatures without dispatching', async (t) => {
    const { webhookRouter, targets } = require('../webhook/router');
    targets.clear();
    t.after(() => targets.clear());
    const handle = t.mock.fn();
    targets.set('/webhooks/webex/oauth/default', {
      account: { accountId: 'default', config: { webhookSecret: 'secret' } },
      handle,
    });

    for (const signature of ['short', '0'.repeat(40)]) {
      const response = makeResponse(t);
      await webhookRouter(
        makeRequest({
          url: '/webhooks/webex/oauth/default',
          body: '{}',
          headers: { 'x-spark-signature': signature },
        }),
        response
      );
      assert.equal(response.statusCode, 401);
    }
    assert.equal(handle.mock.callCount(), 0);
  });

  test('turns request-stream failures into a 400 response', async (t) => {
    const { webhookRouter, targets } = require('../webhook/router');
    targets.clear();
    t.after(() => targets.clear());
    targets.set('/webhooks/webex/oauth/default', {
      account: { accountId: 'default', config: {} },
      handle: t.mock.fn(),
    });
    const request = new Readable({
      read() {
        this.destroy(new Error('socket reset'));
      },
    });
    request.method = 'POST';
    request.url = '/webhooks/webex/oauth/default';
    request.headers = {};
    const response = makeResponse(t);

    assert.equal(await webhookRouter(request, response), true);
    assert.equal(response.statusCode, 400);
    assert.equal(response.body, 'Bad Request');
  });

  test('keeps the acknowledgement successful when async target handling fails', async (t) => {
    const { webhookRouter, targets } = require('../webhook/router');
    targets.clear();
    t.after(() => targets.clear());
    const error = t.mock.method(console, 'error', () => undefined);
    targets.set('/webhooks/webex/oauth/default', {
      account: { accountId: 'default', config: {} },
      handle: t.mock.fn(async () => {
        throw new Error('inbound processing failed');
      }),
    });
    const response = makeResponse(t);

    await webhookRouter(
      makeRequest({ url: '/webhooks/webex/oauth/default', body: '{}' }),
      response
    );
    await flushMicrotasks();

    assert.equal(response.statusCode, 200);
    assert.ok(
      error.mock.calls.some((call) =>
        call.arguments[0].includes('inbound processing failed')
      )
    );
  });
});

// Category: OAuth token state and refresh.
// These tests verify in-memory token updates and the refresh-token form exchange for success and error responses.
describe('OAuth token state and refresh', () => {
  test('stores the active token and refreshes it through the Webex OAuth endpoint', async (t) => {
    const tokenModule = require('../token');
    t.after(() => tokenModule.setAccessToken(null));
    tokenModule.setAccessToken('cached-token');
    assert.equal(tokenModule.getAccessToken(), 'cached-token');

    const fetchMock = t.mock.method(globalThis, 'fetch', async () => ({
      ok: true,
      json: async () => ({ access_token: 'fresh-token' }),
    }));
    const fresh = await tokenModule.refreshAccessToken({
      clientId: 'client',
      clientSecret: 'secret',
      refreshToken: 'refresh',
    });

    assert.equal(fresh, 'fresh-token');
    const [url, options] = fetchMock.mock.calls[0].arguments;
    assert.equal(url, 'https://webexapis.com/v1/access_token');
    assert.equal(options.method, 'POST');
    assert.match(options.body, /grant_type=refresh_token/);
    assert.match(options.body, /client_id=client/);
  });

  test('rejects an unsuccessful refresh with response context', async (t) => {
    t.mock.method(globalThis, 'fetch', async () => ({
      ok: false,
      status: 401,
      text: async () => 'invalid refresh token',
    }));
    const { refreshAccessToken } = require('../token');

    await assert.rejects(
      refreshAccessToken({
        clientId: 'client',
        clientSecret: 'secret',
        refreshToken: 'refresh',
      }),
      /token refresh → 401: invalid refresh token/
    );
  });
});

// Category: Webhook registration lifecycle.
// These tests verify idempotent registration, duplicate cleanup, bot/OAuth ownership, required configuration, and targeted deregistration.
describe('webhook registration lifecycle', () => {
  test('keeps one matching bot webhook, deletes duplicates, and creates the OAuth webhook', async (t) => {
    const state = {
      'bot-token': [
        {
          id: 'bot-keep',
          name: 'Existing',
          targetUrl: 'https://example/bot',
          resource: 'attachmentActions',
          event: 'created',
          status: 'active',
        },
        {
          id: 'bot-duplicate',
          name: 'Duplicate',
          targetUrl: 'https://example/bot',
          resource: 'attachmentActions',
          event: 'created',
          status: 'active',
        },
      ],
      'oauth-token': [],
    };
    const webexFetch = t.mock.fn(async (token, apiPath, options = {}) => {
      if (apiPath === '/webhooks' && (options.method ?? 'GET') === 'GET') {
        return { items: [...state[token]] };
      }
      if (apiPath.startsWith('/webhooks/') && options.method === 'DELETE') {
        const id = apiPath.split('/').at(-1);
        state[token] = state[token].filter((entry) => entry.id !== id);
        return null;
      }
      if (apiPath === '/webhooks' && options.method === 'POST') {
        const created = { id: 'oauth-created', status: 'active', ...options.body };
        state[token].push(created);
        return created;
      }
      throw new Error(`unexpected call ${token} ${apiPath}`);
    });
    const loaded = loadWithMocks(require.resolve('../webhook/registration'), {
      [require.resolve('../api')]: { webexFetch },
      [require.resolve('../token')]: { getAccessToken: () => 'oauth-token' },
    });
    t.after(loaded.restore);

    const result = await loaded.subject.ensureWebhooks({
      cfg: {
        token: 'bot-token',
        botWebhookUrl: 'https://example/bot',
        oauthWebhookUrl: 'https://example/oauth',
        webhookSecret: 'webhook-secret',
      },
      account: { accountId: 'default' },
      log: makeLog(t),
    });

    assert.equal(result.botWebhook.id, 'bot-keep');
    assert.equal(result.oauthWebhook.id, 'oauth-created');
    assert.deepEqual(state['bot-token'].map((entry) => entry.id), ['bot-keep']);
    assert.equal(state['oauth-token'][0].secret, 'webhook-secret');
  });

  test('creates missing owner webhooks without an optional secret', async (t) => {
    const createdBodies = [];
    const webexFetch = t.mock.fn(async (_token, apiPath, options = {}) => {
      if (apiPath === '/webhooks' && (options.method ?? 'GET') === 'GET') {
        return { items: [] };
      }
      if (apiPath === '/webhooks' && options.method === 'POST') {
        createdBodies.push(options.body);
        return { id: `created-${createdBodies.length}`, ...options.body };
      }
      throw new Error('unexpected Webex request');
    });
    const loaded = loadWithMocks(require.resolve('../webhook/registration'), {
      [require.resolve('../api')]: { webexFetch },
      [require.resolve('../token')]: { getAccessToken: () => 'oauth-token' },
    });
    t.after(loaded.restore);

    const result = await loaded.subject.ensureWebhooks({
      cfg: {
        token: 'bot-token',
        botWebhookUrl: 'https://example/bot',
        oauthWebhookUrl: 'https://example/oauth',
      },
      account: { accountId: 'default' },
      log: makeLog(t),
    });

    assert.equal(result.botWebhook.id, 'created-1');
    assert.equal(result.oauthWebhook.id, 'created-2');
    assert.equal(Object.hasOwn(createdBodies[0], 'secret'), false);
    assert.equal(Object.hasOwn(createdBodies[1], 'secret'), false);
  });

  test('requires both ownership tokens and both target URLs', async (t) => {
    const loaded = loadWithMocks(require.resolve('../webhook/registration'), {
      [require.resolve('../api')]: { webexFetch: t.mock.fn() },
      [require.resolve('../token')]: { getAccessToken: () => null },
    });
    t.after(loaded.restore);

    await assert.rejects(
      loaded.subject.ensureWebhooks({
        cfg: { token: 'bot-token' },
        account: { accountId: 'default' },
        log: makeLog(t),
      }),
      /OAuth access token is required/
    );
  });

  test('reports each missing registration prerequisite before API access', async (t) => {
    const webexFetch = t.mock.fn();
    const cases = [
      [{}, 'oauth-token', /Webex bot token is required/],
      [{ token: 'bot-token' }, null, /OAuth access token is required/],
      [{ token: 'bot-token', oauthWebhookUrl: 'https://example/oauth' }, 'oauth-token', /cfg\.botWebhookUrl is required/],
      [{ token: 'bot-token', botWebhookUrl: 'https://example/bot' }, 'oauth-token', /cfg\.oauthWebhookUrl is required/],
    ];

    for (const [cfg, oauthToken, expected] of cases) {
      const loaded = loadWithMocks(require.resolve('../webhook/registration'), {
        [require.resolve('../api')]: { webexFetch },
        [require.resolve('../token')]: { getAccessToken: () => oauthToken },
      });
      await assert.rejects(
        loaded.subject.ensureWebhooks({
          cfg,
          account: { accountId: 'default' },
          log: makeLog(t),
        }),
        expected
      );
      loaded.restore();
    }
    assert.equal(webexFetch.mock.callCount(), 0);
  });

  test('deletes only configured target URLs from bot and OAuth owners', async (t) => {
    const deletes = [];
    const webexFetch = t.mock.fn(async (token, apiPath, options = {}) => {
      if (apiPath === '/webhooks') {
        return {
          items: [
            { id: `${token}-target`, targetUrl: 'https://example/bot' },
            { id: `${token}-other`, targetUrl: 'https://other' },
          ],
        };
      }
      if (options.method === 'DELETE') {
        deletes.push([token, apiPath]);
        return null;
      }
      throw new Error('unexpected call');
    });
    const loaded = loadWithMocks(require.resolve('../webhook/registration'), {
      [require.resolve('../api')]: { webexFetch },
      [require.resolve('../token')]: { getAccessToken: () => 'oauth-token' },
    });
    t.after(loaded.restore);

    const deleted = await loaded.subject.deregisterWebhooks(
      {
        token: 'bot-token',
        botWebhookUrl: 'https://example/bot',
        oauthWebhookUrl: 'https://example/oauth',
      },
      { log: makeLog(t) }
    );

    assert.equal(deleted.length, 2);
    assert.deepEqual(deletes, [
      ['bot-token', '/webhooks/bot-token-target'],
      ['oauth-token', '/webhooks/oauth-token-target'],
    ]);
  });

  test('requires a deregistration target and skips owners without tokens', async (t) => {
    const webexFetch = t.mock.fn(async () => ({ items: [] }));
    const loaded = loadWithMocks(require.resolve('../webhook/registration'), {
      [require.resolve('../api')]: { webexFetch },
      [require.resolve('../token')]: { getAccessToken: () => null },
    });
    t.after(loaded.restore);

    await assert.rejects(
      loaded.subject.deregisterWebhooks({ token: 'bot-token' }),
      /at least one webhook URL is required/
    );
    const deleted = await loaded.subject.deregisterWebhooks({
      botWebhookUrl: 'https://example/bot',
    });
    assert.deepEqual(deleted, []);
    assert.equal(webexFetch.mock.callCount(), 0);
  });
});

function loadChannel(t) {
  const collaborators = {
    webexFetch: t.mock.fn(async () => ({ id: 'bot-1' })),
    ensureWebhooks: t.mock.fn(async () => ({ botWebhook: {}, oauthWebhook: {} })),
    deregisterWebhooks: t.mock.fn(async () => []),
    getAccessToken: t.mock.fn(() => 'oauth-token'),
    setAccessToken: t.mock.fn(),
    refreshAccessToken: t.mock.fn(async () => 'fresh-token'),
    targets: new Map(),
    handleInboundWebexWebhook: t.mock.fn(async () => undefined),
    sendWebexMessage: t.mock.fn(async () => ({ id: 'sent-1', roomId: 'space-1' })),
    runPendingBatchStagingRecovery: t.mock.fn(async () => undefined),
    handleStagePendingBatchRequest: t.mock.fn(async () => undefined),
  };
  const loaded = loadWithMocks(require.resolve('../channel'), {
    [require.resolve('../api')]: {
      WEBEX_API: 'https://webexapis.com/v1',
      webexFetch: collaborators.webexFetch,
    },
    [require.resolve('../webhook/registration')]: {
      ensureWebhooks: collaborators.ensureWebhooks,
      deregisterWebhooks: collaborators.deregisterWebhooks,
    },
    [require.resolve('../token')]: {
      getAccessToken: collaborators.getAccessToken,
      setAccessToken: collaborators.setAccessToken,
      refreshAccessToken: collaborators.refreshAccessToken,
    },
    [require.resolve('../webhook/router')]: {
      targets: collaborators.targets,
      normPath: (value) => value.replace(/\/$/, ''),
    },
    [require.resolve('../inbound')]: {
      handleInboundWebexWebhook: collaborators.handleInboundWebexWebhook,
    },
    [require.resolve('../send')]: {
      sendWebexMessage: collaborators.sendWebexMessage,
    },
    [require.resolve('../batch/schedule')]: {
      runPendingBatchStagingRecovery:
        collaborators.runPendingBatchStagingRecovery,
    },
    [require.resolve('../batch/staging-handler')]: {
      handleStagePendingBatchRequest:
        collaborators.handleStagePendingBatchRequest,
    },
  });
  t.after(loaded.restore);
  return { ...loaded.subject, collaborators };
}

// Category: Channel account, security, target, outbound, and status contracts.
// These tests verify the OpenClaw channel adapter resolves inherited accounts, normalises targets, maps DM policy, sends output, and reports health state.
describe('channel adapter contracts', () => {
  test('resolves default and named account configuration with inheritance', (t) => {
    t.mock.method(console, 'log', () => undefined);
    const { webexPlugin } = loadChannel(t);
    const cfg = {
      channels: {
        webex: {
          token: 'default-token',
          dmPolicy: 'allowlisted',
          allowFrom: ['person@example.com'],
          accounts: {
            secondary: { token: 'secondary-token', dmPolicy: 'allow' },
          },
        },
      },
    };

    assert.deepEqual(webexPlugin.config.listAccountIds(cfg), ['default', 'secondary']);
    const named = webexPlugin.config.resolveAccount(cfg, 'secondary');
    assert.equal(named.config.token, 'secondary-token');
    assert.equal(named.config.dmPolicy, 'allow');
    assert.deepEqual(named.config.allowFrom, ['person@example.com']);
    assert.equal(webexPlugin.config.resolveAccount(cfg, 'missing').configured, false);

    const policy = webexPlugin.security.resolveDmPolicy({
      account: webexPlugin.config.resolveAccount(cfg),
    });
    assert.equal(policy.policy, 'allowlist');
    assert.equal(policy.normalizeEntry(' Person@Example.COM '), 'person@example.com');

    const disabled = webexPlugin.config.resolveAccount(
      {
        channels: {
          webex: {
            enabled: false,
            token: 'default-token',
            botWebhookUrl: 'https://default/bot',
            oauthWebhookUrl: 'https://default/oauth',
            accounts: {
              default: { token: 'ignored-default-entry' },
              full: {
                token: 'full-token',
                botWebhookUrl: 'https://full/bot',
                oauthWebhookUrl: 'https://full/oauth',
                webhookSecret: 'hook-secret',
                allowFrom: ['person-1'],
                accessToken: 'access-token',
                refreshToken: 'refresh-token',
                clientId: 'client-id',
                clientSecret: 'client-secret',
              },
            },
          },
        },
      },
      'full'
    );
    assert.equal(disabled.enabled, false);
    assert.deepEqual(disabled.config, {
      token: 'full-token',
      botWebhookUrl: 'https://full/bot',
      oauthWebhookUrl: 'https://full/oauth',
      webhookSecret: 'hook-secret',
      dmPolicy: 'deny',
      allowFrom: ['person-1'],
      accessToken: 'access-token',
      clientId: 'client-id',
      clientSecret: 'client-secret',
      refreshToken: 'refresh-token',
    });
  });

  test('normalises destinations and sends text and media through the resolved account', async (t) => {
    const { webexPlugin, collaborators } = loadChannel(t);
    assert.equal(webexPlugin.messaging.normalizeTarget(' webex:room-1 '), 'room-1');
    assert.equal(webexPlugin.messaging.normalizeTarget('  '), undefined);
    assert.equal(webexPlugin.messaging.targetResolver.looksLikeId('person@example.com'), true);

    const resolvedAccount = {
      accountId: 'default',
      configured: true,
      config: { token: 'bot-token' },
    };
    const textResult = await webexPlugin.outbound.sendText({
      to: 'space-1',
      text: 'Hello',
      replyToId: 'parent-1',
      account: resolvedAccount,
    });
    const mediaResult = await webexPlugin.outbound.sendMedia({
      to: 'space-1',
      text: 'Image',
      mediaUrl: 'https://example/image.png',
      account: resolvedAccount,
    });

    assert.deepEqual(textResult, {
      channel: 'webex',
      messageId: 'sent-1',
      roomId: 'space-1',
    });
    assert.deepEqual(collaborators.sendWebexMessage.mock.calls[0].arguments[0], {
      token: 'bot-token',
      to: 'space-1',
      text: 'Hello',
      parentId: 'parent-1',
    });
    assert.equal(
      collaborators.sendWebexMessage.mock.calls[1].arguments[0].files[0],
      'https://example/image.png'
    );
    assert.equal(mediaResult.messageId, 'sent-1');
  });

  test('summarises runtime status and probes configured accounts', async (t) => {
    const { webexPlugin } = loadChannel(t);
    assert.deepEqual(
      webexPlugin.status.collectStatusIssues([
        { accountId: 'ok', lastError: '' },
        { accountId: 'bad', lastError: ' failure ' },
      ]),
      [
        {
          channel: 'webex',
          accountId: 'bad',
          kind: 'runtime',
          message: 'Channel error: failure',
        },
      ]
    );
    assert.deepEqual(
      await webexPlugin.status.probeAccount({ account: { configured: false } }),
      { ok: false, error: 'Not configured', elapsedMs: 0 }
    );

    t.mock.method(globalThis, 'fetch', async () => ({ ok: false, status: 503 }));
    const probe = await webexPlugin.status.probeAccount({
      account: { configured: true, config: { token: 'bot-token' } },
      timeoutMs: 100,
    });
    assert.equal(probe.ok, false);
    assert.equal(probe.error, 'HTTP 503');
  });

  test('covers empty configuration, metadata, threading, and target contracts', (t) => {
    t.mock.method(console, 'log', () => undefined);
    const { webexPlugin } = loadChannel(t);

    assert.deepEqual(webexPlugin.config.listAccountIds({}), []);
    assert.equal(webexPlugin.config.defaultAccountId(), 'default');
    const account = webexPlugin.config.resolveAccount({ channels: { webex: {} } });
    assert.equal(webexPlugin.config.isConfigured(account), false);
    assert.deepEqual(webexPlugin.config.describeAccount(account), {
      accountId: 'default',
      enabled: true,
      configured: false,
      baseUrl: 'https://webexapis.com/v1',
    });
    assert.equal(webexPlugin.threading.resolveReplyToMode(), 'off');
    const replied = { current: true };
    assert.deepEqual(
      webexPlugin.threading.buildToolContext({
        context: {
          To: ' room-1 ',
          MessageThreadId: 42,
          ReplyToId: 'fallback-parent',
        },
        hasRepliedRef: replied,
      }),
      {
        currentChannelId: 'room-1',
        currentThreadTs: '42',
        hasRepliedRef: replied,
      }
    );
    assert.deepEqual(
      webexPlugin.threading.buildToolContext({
        context: { To: ' ', ReplyToId: 'parent-1' },
        hasRepliedRef: replied,
      }),
      {
        currentChannelId: undefined,
        currentThreadTs: 'parent-1',
        hasRepliedRef: replied,
      }
    );
    assert.equal(webexPlugin.messaging.targetResolver.looksLikeId('Y2LZY29ZCGFYAZOVL3abc'), true);
    assert.equal(webexPlugin.messaging.targetResolver.looksLikeId('friendly room'), false);
  });

  test('rejects outbound delivery without an account token', async (t) => {
    t.mock.method(console, 'log', () => undefined);
    const { webexPlugin, collaborators } = loadChannel(t);
    const cfg = { channels: { webex: {} } };

    await assert.rejects(
      webexPlugin.outbound.sendText({ cfg, to: 'room-1', text: 'Hello' }),
      /missing resolvedAccount\.config\.token/
    );
    await assert.rejects(
      webexPlugin.outbound.sendMedia({ cfg, to: 'room-1', text: 'Hello' }),
      /missing resolvedAccount\.config\.token/
    );
    assert.equal(collaborators.sendWebexMessage.mock.callCount(), 0);
  });

  test('builds status snapshots and covers successful and failed probes', async (t) => {
    const { webexPlugin } = loadChannel(t);
    const account = {
      accountId: 'secondary',
      enabled: true,
      configured: true,
      config: { token: 'bot-token' },
    };
    assert.deepEqual(
      webexPlugin.status.buildAccountSnapshot({
        account,
        runtime: { running: true, lastStartAt: 'start', lastProbeAt: 'probe' },
        probe: { ok: true },
      }),
      {
        accountId: 'secondary',
        enabled: true,
        configured: true,
        baseUrl: 'https://webexapis.com/v1',
        running: true,
        lastStartAt: 'start',
        lastStopAt: null,
        lastError: null,
        probe: { ok: true },
        lastProbeAt: 'probe',
      }
    );

    t.mock.method(globalThis, 'fetch', async () => ({ ok: true, status: 200 }));
    const successful = await webexPlugin.status.probeAccount({ account });
    assert.equal(successful.ok, true);
    assert.ok(successful.elapsedMs >= 0);

    globalThis.fetch.mock.mockImplementation(async () => {
      throw new Error('network unavailable');
    });
    const failed = await webexPlugin.status.probeAccount({ account });
    assert.equal(failed.ok, false);
    assert.equal(failed.error, 'network unavailable');
  });
});

// Category: Channel startup wiring.
// These tests verify account startup initialises identity/token state, ensures remote webhooks, installs bot/OAuth local targets, and starts batch recovery.
describe('channel startup wiring', () => {
  test('initialises a configured account and installs both inbound targets', async (t) => {
    const { webexPlugin, collaborators } = loadChannel(t);
    const log = makeLog(t);
    const setStatus = t.mock.fn();
    const startup = webexPlugin.gateway.startAccount({
      account: {
        accountId: 'default',
        config: {
          token: 'bot-token',
          accessToken: 'stored-oauth-token',
          botWebhookUrl: 'https://example/bot',
          oauthWebhookUrl: 'https://example/oauth',
        },
      },
      log,
      setStatus,
    });
    void startup;

    for (let index = 0; index < 12; index += 1) await Promise.resolve();

    assert.equal(setStatus.mock.callCount(), 1);
    assert.deepEqual(collaborators.setAccessToken.mock.calls[0].arguments, [
      'stored-oauth-token',
    ]);
    assert.deepEqual(collaborators.webexFetch.mock.calls[0].arguments, [
      'bot-token',
      '/people/me',
    ]);
    assert.equal(collaborators.ensureWebhooks.mock.callCount(), 1);
    assert.equal(collaborators.targets.size, 2);
    assert.ok(collaborators.targets.has('/webhooks/webex/bot/default'));
    assert.ok(collaborators.targets.has('/webhooks/webex/oauth/default'));
    assert.equal(collaborators.runPendingBatchStagingRecovery.mock.callCount(), 1);

    await collaborators.targets.get('/webhooks/webex/bot/default').handle({ id: 'bot-hook' });
    await collaborators.targets.get('/webhooks/webex/oauth/default').handle({ id: 'oauth-hook' });
    assert.equal(collaborators.handleInboundWebexWebhook.mock.callCount(), 2);
    const botInboundCtx =
      collaborators.handleInboundWebexWebhook.mock.calls[0].arguments[1];
    const oauthInboundCtx =
      collaborators.handleInboundWebexWebhook.mock.calls[1].arguments[1];
    assert.equal(botInboundCtx.identity, 'bot');
    assert.equal(botInboundCtx.tokenKind, 'bot');
    assert.equal(botInboundCtx.botId, 'bot-1');
    assert.equal(oauthInboundCtx.identity, 'oauth');
    assert.equal(oauthInboundCtx.tokenKind, 'oauth');
    assert.equal(oauthInboundCtx.botId, 'bot-1');

    collaborators.targets.clear();
  });

  test('refreshes OAuth on startup and on the configured interval', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const { webexPlugin, collaborators } = loadChannel(t);
    let refreshCount = 0;
    collaborators.refreshAccessToken.mock.mockImplementation(async () => {
      refreshCount += 1;
      return refreshCount === 1 ? 'startup-token' : 'periodic-token';
    });
    const log = makeLog(t);

    void webexPlugin.gateway.startAccount({
      account: {
        accountId: 'default',
        config: {
          token: 'bot-token',
          accessToken: 'stored-token',
          refreshToken: 'refresh-token',
          clientId: 'client-id',
          clientSecret: 'client-secret',
        },
      },
      log,
      setStatus: t.mock.fn(),
    });
    await flushMicrotasks();

    assert.deepEqual(collaborators.setAccessToken.mock.calls[0].arguments, [
      'startup-token',
    ]);
    t.mock.timers.tick(12 * 24 * 60 * 60 * 1000);
    await flushMicrotasks();
    assert.equal(collaborators.refreshAccessToken.mock.callCount(), 2);
    assert.deepEqual(collaborators.setAccessToken.mock.calls[1].arguments, [
      'periodic-token',
    ]);
    collaborators.refreshAccessToken.mock.mockImplementation(async () => {
      throw new Error('periodic refresh rejected');
    });
    t.mock.timers.tick(12 * 24 * 60 * 60 * 1000);
    await flushMicrotasks();
    assert.equal(collaborators.refreshAccessToken.mock.callCount(), 3);
    assert.ok(
      mockCalls(log.warn).some(([message]) =>
        message.includes('token refresh failed: periodic refresh rejected')
      )
    );
    assert.ok(
      mockCalls(log.info).some(([message]) => message.includes('access token refreshed'))
    );
    collaborators.targets.clear();
  });

  test('falls back to the stored OAuth token when startup refresh fails', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const { webexPlugin, collaborators } = loadChannel(t);
    collaborators.refreshAccessToken.mock.mockImplementation(async () => {
      throw new Error('refresh rejected');
    });
    const log = makeLog(t);

    void webexPlugin.gateway.startAccount({
      account: {
        accountId: 'default',
        config: {
          token: 'bot-token',
          accessToken: 'stored-token',
          refreshToken: 'refresh-token',
          clientId: 'client-id',
          clientSecret: 'client-secret',
        },
      },
      log,
    });
    await flushMicrotasks();

    assert.deepEqual(collaborators.setAccessToken.mock.calls[0].arguments, [
      'stored-token',
    ]);
    assert.ok(
      mockCalls(log.warn).some(([message]) =>
        message.includes('startup token refresh failed: refresh rejected')
      )
    );
    collaborators.targets.clear();
  });

  test('cleans up both local targets and contains remote deregistration failure', async (t) => {
    const { cleanupAccountResources, collaborators } = loadChannel(t);
    const clearIntervalMock = t.mock.method(globalThis, 'clearInterval', () => undefined);
    collaborators.targets.set('/webhooks/webex/bot/default', {});
    collaborators.targets.set('/webhooks/webex/oauth/default', {});
    collaborators.targets.set('/webhooks/webex/bot/other', {});
    collaborators.deregisterWebhooks.mock.mockImplementation(async () => {
      throw new Error('Webex unavailable');
    });
    const log = makeLog(t);
    const cfg = { token: 'bot-token' };

    await cleanupAccountResources({
      account: { accountId: 'default' },
      cfg,
      log,
      refreshInterval: 123,
      botWebhookPath: '/webhooks/webex/bot/default',
      oauthWebhookPath: '/webhooks/webex/oauth/default',
    });

    assert.deepEqual(clearIntervalMock.mock.calls[0].arguments, [123]);
    assert.equal(collaborators.targets.has('/webhooks/webex/bot/default'), false);
    assert.equal(collaborators.targets.has('/webhooks/webex/oauth/default'), false);
    assert.equal(collaborators.targets.has('/webhooks/webex/bot/other'), true);
    assert.deepEqual(collaborators.deregisterWebhooks.mock.calls[0].arguments, [
      cfg,
      { log },
    ]);
    assert.ok(
      mockCalls(log.warn).some(([message]) =>
        message.includes('webhook deregister failed: Webex unavailable')
      )
    );
    collaborators.targets.clear();
  });
});

// Category: Plugin registration and tool exposure.
// These tests verify the entry point installs the runtime, channel, three HTTP routes, and both batch-management tools with OpenClaw.
describe('plugin registration and tool exposure', () => {
  test('requires runtime registration before runtime-dependent handlers execute', () => {
    const runtimeModule = require('../runtime');
    runtimeModule.setPluginRuntime(null);
    assert.throws(
      () => runtimeModule.getPluginRuntime(),
      /pluginRuntime has not been set/
    );
    const runtime = { name: 'runtime' };
    runtimeModule.setPluginRuntime(runtime);
    assert.equal(runtimeModule.getPluginRuntime(), runtime);
    runtimeModule.setPluginRuntime(null);
  });

  test('registers every main Webex surface exactly once', (t) => {
    const webexPlugin = { id: 'webex' };
    const webhookRouter = t.mock.fn();
    const contextRouter = t.mock.fn();
    const boardRouter = t.mock.fn();
    const setPluginRuntime = t.mock.fn();
    const routeTool = { name: 'route_message' };
    const tagTool = { name: 'tag_message' };
    const loadTool = { name: 'load' };
    const completeTool = { name: 'complete' };
    const loaded = loadWithMocks(require.resolve('../index'), {
      [require.resolve('../channel')]: { webexPlugin },
      [require.resolve('../webhook/router')]: { webhookRouter },
      [require.resolve('../visibility/context-router')]: { contextRouter },
      [require.resolve('../visibility/board-router')]: { boardRouter },
      [require.resolve('../runtime')]: { setPluginRuntime, setPluginConfig: t.mock.fn() },
      [require.resolve('../routing/tool')]: { routeMessageTool: () => routeTool },
      [require.resolve('../tagging/tool')]: { tagMessageTool: () => tagTool },
      [require.resolve('../tools/load-processing-batch')]: {
        loadProcessingBatchTool: () => loadTool,
      },
      [require.resolve('../tools/complete-processing-batch')]: {
        completeProcessingBatchTool: () => completeTool,
      },
    });
    t.after(loaded.restore);
    const api = {
      runtime: { name: 'runtime' },
      registerChannel: t.mock.fn(),
      registerHttpRoute: t.mock.fn(),
      registerTool: t.mock.fn(),
    };

    loaded.subject(api);

    assert.deepEqual(setPluginRuntime.mock.calls[0].arguments, [api.runtime]);
    assert.deepEqual(api.registerChannel.mock.calls[0].arguments[0], {
      plugin: webexPlugin,
    });
    assert.equal(api.registerHttpRoute.mock.callCount(), 3);
    assert.deepEqual(
      api.registerHttpRoute.mock.calls.map((call) => call.arguments[0].path),
      ['/webhooks/webex/', '/webex/collab/board', '/webex/collab/']
    );
    assert.deepEqual(
      api.registerTool.mock.calls.map((call) => call.arguments[0]),
      [routeTool, tagTool, loadTool, completeTool]
    );
  });

  test('delegates load and complete tool execution to batch storage', async (t) => {
    t.mock.method(console, 'info', () => undefined);
    const loadProcessingBatch = t.mock.fn(async () => ({
      messageCount: 1,
      messages: [{ id: 'message-1' }],
    }));
    const completeProcessingBatch = t.mock.fn(async () => ({
      completedAt: '2026-01-01T00:00:00Z',
    }));
    const loadModule = loadWithMocks(
      require.resolve('../tools/load-processing-batch'),
      {
        [require.resolve('../batch/load')]: { loadProcessingBatch },
      }
    );
    const completeModule = loadWithMocks(
      require.resolve('../tools/complete-processing-batch'),
      {
        [require.resolve('../batch/complete')]: { completeProcessingBatch },
      }
    );
    t.after(loadModule.restore);
    t.after(completeModule.restore);

    await loadModule.subject.loadProcessingBatchTool().execute('tool-1', {
      spaceId: 'space-1',
      batchId: 'batch-1',
    });
    await completeModule.subject.completeProcessingBatchTool().execute('tool-2', {
      spaceId: 'space-1',
      batchId: 'batch-1',
      result: { ok: true },
    });

    assert.deepEqual(loadProcessingBatch.mock.calls[0].arguments[0], {
      spaceId: 'space-1',
      batchId: 'batch-1',
    });
    assert.deepEqual(completeProcessingBatch.mock.calls[0].arguments[0], {
      spaceId: 'space-1',
      batchId: 'batch-1',
      result: { ok: true },
    });
  });
});

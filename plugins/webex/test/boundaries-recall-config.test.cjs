'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { loadWithMocks, makeLog, mockCalls } = require('./helpers.cjs');

// Category: Webex REST boundary.
// These tests verify authentication, request serialisation, successful JSON decoding, harmless DELETE 404s, and informative HTTP failures.
describe('Webex REST boundary', () => {
  test('sends an authenticated JSON request and returns its decoded response', async (t) => {
    const fetchMock = t.mock.method(globalThis, 'fetch', async () => ({
      ok: true,
      status: 200,
      json: async () => ({ id: 'message-1' }),
    }));
    const { webexFetch } = require('../api');

    const response = await webexFetch('token-1', '/messages', {
      method: 'POST',
      body: { roomId: 'space-1', text: 'Hello' },
    });

    assert.deepEqual(response, { id: 'message-1' });
    const [url, options] = fetchMock.mock.calls[0].arguments;
    assert.equal(url, 'https://webexapis.com/v1/messages');
    assert.equal(options.method, 'POST');
    assert.equal(options.headers.Authorization, 'Bearer token-1');
    assert.equal(options.body, '{"roomId":"space-1","text":"Hello"}');
  });

  test('accepts DELETE 404 and rejects other unsuccessful responses', async (t) => {
    const fetchMock = t.mock.method(globalThis, 'fetch', async () => ({
      ok: false,
      status: 404,
      text: async () => 'missing',
    }));
    const { webexFetch } = require('../api');

    assert.equal(
      await webexFetch('token-1', '/webhooks/missing', { method: 'DELETE' }),
      null
    );

    fetchMock.mock.mockImplementationOnce(async () => ({
      ok: false,
      status: 503,
      text: async () => 'service unavailable',
    }));
    await assert.rejects(
      webexFetch('token-1', '/messages'),
      /Webex GET \/messages → 503: service unavailable/
    );
  });

  test('returns null for successful deletes and tolerates unreadable error bodies', async (t) => {
    const fetchMock = t.mock.method(globalThis, 'fetch', async () => ({
      ok: true,
      status: 204,
    }));
    const { webexFetch } = require('../api');

    assert.equal(
      await webexFetch('token-1', '/webhooks/hook-1', { method: 'DELETE' }),
      null
    );
    fetchMock.mock.mockImplementationOnce(async () => ({
      ok: false,
      status: 502,
      text: async () => {
        throw new Error('body unavailable');
      },
    }));
    await assert.rejects(
      webexFetch('token-1', '/messages'),
      /Webex GET \/messages → 502: $/
    );
  });
});

// Category: Webex message construction and sending.
// These tests verify destination inference, optional content fields, parent threading, validation, and delegation to the REST boundary.
describe('Webex message construction and sending', () => {
  test('builds email, person, and room destinations with supported content', () => {
    const { buildMsgBody } = require('../send');
    const personId = Buffer.from('ciscospark://us/PEOPLE/person-1').toString('base64');

    assert.deepEqual(buildMsgBody('person@example.com', { text: 'Hello' }), {
      toPersonEmail: 'person@example.com',
      text: 'Hello',
    });
    assert.deepEqual(buildMsgBody(personId, { markdown: '**Hi**' }, 'parent-1'), {
      toPersonId: personId,
      markdown: '**Hi**',
      parentId: 'parent-1',
    });
    assert.deepEqual(
      buildMsgBody(
        'room-id',
        {
          files: ['first.png', 'ignored.png'],
          attachments: [{ contentType: 'application/test' }],
        }
      ),
      {
        roomId: 'room-id',
        files: ['first.png'],
        attachments: [{ contentType: 'application/test' }],
      }
    );
  });

  test('validates required fields and posts the constructed body', async (t) => {
    const webexFetch = t.mock.fn(async () => ({ id: 'message-1', roomId: 'space-1' }));
    const loaded = loadWithMocks(require.resolve('../send'), {
      [require.resolve('../api')]: { webexFetch },
    });
    t.after(loaded.restore);

    await assert.rejects(loaded.subject.sendWebexMessage({ to: 'space-1' }), /token/);
    await assert.rejects(loaded.subject.sendWebexMessage({ token: 'token-1' }), /target/);

    await loaded.subject.sendWebexMessage({
      token: 'token-1',
      to: 'space-1',
      markdown: '**Hello**',
      parentId: 'parent-1',
    });
    assert.deepEqual(webexFetch.mock.calls[0].arguments, [
      'token-1',
      '/messages',
      {
        method: 'POST',
        body: { roomId: 'space-1', markdown: '**Hello**', parentId: 'parent-1' },
      },
    ]);
  });
});

// Category: Recall context assembly.
// These tests verify recall uses bounded active project context and formats current messages, conversations, and items without leaking extra fields.
describe('recall context assembly', () => {
  test('queries active context and returns the formatted recall record', async (t) => {
    const getConversations = t.mock.fn(async () => [
      {
        id: 'conv-1',
        topic: 'Release',
        summary: 'Release work',
        status: 'active',
        updatedAt: '2026-01-01',
        internal: 'omit',
      },
    ]);
    const getItems = t.mock.fn(async () => [
      {
        id: 'item-1',
        type: 'task',
        status: 'open',
        title: 'Ship',
        description: 'Ship release',
        conversationIds: ['conv-1'],
        evidenceMessageIds: ['message-0'],
      },
    ]);
    const loaded = loadWithMocks(require.resolve('../recall/context'), {
      [require.resolve('../context/conversations-store')]: { getConversations },
      [require.resolve('../context/items-store')]: { getItems },
    });
    t.after(loaded.restore);

    const context = await loaded.subject.buildRecallContext({
      message: {
        id: 'message-1',
        roomId: 'space-1',
        text: 'What is open?',
        personEmail: 'dev@example.com',
      },
      account: { accountId: 'default' },
      log: makeLog(t),
    });

    assert.deepEqual(getConversations.mock.calls[0].arguments[0], {
      spaceId: 'space-1',
      statuses: ['active', 'dormant'],
      limit: 50,
    });
    assert.deepEqual(getItems.mock.calls[0].arguments[0], {
      spaceId: 'space-1',
      statuses: ['open', 'in_progress', 'blocked', 'resolved'],
      limit: 100,
    });
    assert.equal(context.currentMessage.senderName, 'dev@example.com');
    assert.equal(context.conversations[0].internal, undefined);
    assert.deepEqual(context.items[0].conversationIds, ['conv-1']);
  });

  test('validates identifiers and normalises sparse or malformed context records', async (t) => {
    const getConversations = t.mock.fn(async () => [
      { id: 'conv-1', topic: 'Topic', summary: '', status: 'dormant' },
    ]);
    const getItems = t.mock.fn(async () => [
      {
        id: 'item-1',
        type: 'risk',
        status: 'open',
        title: 'Risk',
        conversationIds: 'invalid',
        evidenceMessageIds: null,
      },
    ]);
    const loaded = loadWithMocks(require.resolve('../recall/context'), {
      [require.resolve('../context/conversations-store')]: { getConversations },
      [require.resolve('../context/items-store')]: { getItems },
    });
    t.after(loaded.restore);
    await assert.rejects(
      loaded.subject.buildRecallContext({ account: {} }),
      /message\.roomId is required/
    );
    await assert.rejects(
      loaded.subject.buildRecallContext({ message: { roomId: 'space-1' } }),
      /account is required/
    );

    const context = await loaded.subject.buildRecallContext({
      message: { id: 'message-1', roomId: 'space-1', personId: 'person-1' },
      account: { accountId: 'default' },
      log: makeLog(t),
    });
    assert.deepEqual(context.currentMessage, {
      id: 'message-1',
      text: '',
      senderName: 'person-1',
      createdAt: null,
      parentId: null,
    });
    assert.equal(context.conversations[0].updatedAt, null);
    assert.equal(context.items[0].owner, null);
    assert.deepEqual(context.items[0].conversationIds, []);
    assert.deepEqual(context.items[0].evidenceMessageIds, []);
  });
});

// Category: Recall-agent dispatch and response delivery.
// These tests verify recall builds the dedicated response session and returns trimmed threaded output through the bot token.
describe('recall-agent dispatch and response delivery', () => {
  test('dispatches a recall prompt with canonical and recovery sessions', async (t) => {
    const responseContext = { currentMessage: {}, conversations: [], items: [] };
    const buildRecallContext = t.mock.fn(async () => responseContext);
    const buildRecallInstruction = t.mock.fn(() => 'recall prompt');
    const resultHandler = t.mock.fn();
    const makeRecallResultHandler = t.mock.fn(() => resultHandler);
    let dispatchOptions;
    const dispatchToAgentForSpace = t.mock.fn(async (options) => {
      dispatchOptions = options;
    });
    const loaded = loadWithMocks(require.resolve('../recall/handle-request'), {
      [require.resolve('../dispatch')]: { dispatchToAgentForSpace },
      [require.resolve('../runtime')]: { getPluginRuntime: () => ({ runtime: true }) },
      [require.resolve('../recall/context')]: { buildRecallContext },
      [require.resolve('../recall/instruction')]: { buildRecallInstruction },
      [require.resolve('../recall/result-handler')]: { makeRecallResultHandler },
    });
    t.after(loaded.restore);
    const message = {
      id: 'message-1',
      roomId: 'space-1',
      roomType: 'group',
      personId: 'person-1',
      text: 'What is open?',
    };

    const response = await loaded.subject.handleRecallRequest({
      message,
      account: { accountId: 'default' },
      log: makeLog(t),
    });

    assert.equal(response.dispatched, true);
    assert.deepEqual(buildRecallInstruction.mock.calls[0].arguments[0], {
      responseContext,
    });
    assert.equal(dispatchOptions.buildCtxPayload().CommandBody, 'recall prompt');
    assert.equal(
      dispatchOptions.buildCtxPayload().SessionKey,
      'agent:main:webex:space-1:response'
    );
    assert.equal(
      dispatchOptions.buildCtxPayload('recovery').SessionKey,
      'agent:main:webex:space-1:response:recovery'
    );
    assert.equal(dispatchOptions.onAgentOutput, resultHandler);
  });

  test('validates recall dispatch inputs and builds direct-message defaults', async (t) => {
    let dispatchOptions;
    const loaded = loadWithMocks(require.resolve('../recall/handle-request'), {
      [require.resolve('../dispatch')]: {
        dispatchToAgentForSpace: t.mock.fn(async (options) => {
          dispatchOptions = options;
        }),
      },
      [require.resolve('../runtime')]: { getPluginRuntime: () => ({}) },
      [require.resolve('../recall/context')]: {
        buildRecallContext: t.mock.fn(async () => ({})),
      },
      [require.resolve('../recall/instruction')]: {
        buildRecallInstruction: t.mock.fn(() => 'prompt'),
      },
      [require.resolve('../recall/result-handler')]: {
        makeRecallResultHandler: t.mock.fn(() => t.mock.fn()),
      },
    });
    t.after(loaded.restore);
    await assert.rejects(
      loaded.subject.handleRecallRequest({ account: {} }),
      /message\.roomId is required/
    );
    await assert.rejects(
      loaded.subject.handleRecallRequest({ message: { roomId: 'space-1' } }),
      /account is required/
    );

    await loaded.subject.handleRecallRequest({
      message: {
        id: 'message-1',
        roomId: 'space-1',
        roomType: 'direct',
        personId: 'person-1',
        personEmail: 'person@example.com',
      },
      account: { accountId: 'default' },
      log: makeLog(t),
    });
    const payload = dispatchOptions.buildCtxPayload();
    assert.equal(payload.Body, '');
    assert.equal(payload.RawBody, '');
    assert.equal(payload.ChatType, 'direct');
    assert.equal(payload.SenderName, 'person@example.com');
    assert.equal(payload.MessageThreadId, 'message-1');
  });

  test('skips empty output, requires a token, and sends a trimmed threaded reply', async (t) => {
    const sendWebexMessage = t.mock.fn(async () => ({ id: 'reply-1' }));
    const loaded = loadWithMocks(require.resolve('../recall/result-handler'), {
      [require.resolve('../send')]: { sendWebexMessage },
    });
    t.after(loaded.restore);
    const message = { id: 'message-1', roomId: 'space-1', parentId: 'root-1' };
    const log = makeLog(t);

    const empty = await loaded.subject.makeRecallResultHandler({
      message,
      account: { accountId: 'default', config: { token: 'bot-token' } },
      log,
    })({ text: '   ' });
    assert.equal(empty.skipped, true);

    await assert.rejects(
      loaded.subject.makeRecallResultHandler({
        message,
        account: { accountId: 'default', config: {} },
        log,
      })({ text: 'Answer' }),
      /Webex token is required/
    );

    const sent = await loaded.subject.makeRecallResultHandler({
      message,
      account: { accountId: 'default', config: { token: 'bot-token' } },
      log,
    })({ text: '  Answer  ' });
    assert.equal(sent.response, 'Answer');
    assert.deepEqual(sendWebexMessage.mock.calls[0].arguments[0], {
      token: 'bot-token',
      to: 'space-1',
      markdown: 'Answer',
      parentId: 'root-1',
    });

    const rootReply = await loaded.subject.makeRecallResultHandler({
      message: { id: 'message-2', roomId: 'space-1' },
      account: { accountId: 'default', config: { token: 'bot-token' } },
      log,
    })({ text: 'Root answer' });
    assert.equal(rootReply.sent, true);
    assert.equal(sendWebexMessage.mock.calls[1].arguments[0].parentId, 'message-2');
  });
});

// Category: Configuration submission and card flow.
// These tests verify invalid submissions receive actionable feedback and valid submissions are persisted, acknowledged, and redisplayed through the config route.
describe('configuration submission and card flow', () => {
  test('rejects invalid fields without writing configuration', async (t) => {
    const writeActiveConfig = t.mock.fn();
    const sendWebexMessage = t.mock.fn(async () => ({ id: 'message-1' }));
    const loaded = loadWithMocks(require.resolve('../config/handle-submission'), {
      [require.resolve('../config/store')]: { writeActiveConfig },
      [require.resolve('../send')]: { sendWebexMessage },
    });
    t.after(loaded.restore);

    const response = await loaded.subject.handleConfigSubmission({
      action: {
        roomId: 'space-1',
        messageId: 'card-message',
        inputs: { projectName: '', githubRepo: 'bad repo', responseMode: 'unknown' },
      },
      account: { accountId: 'default', config: { token: 'bot-token' } },
      log: makeLog(t),
    });

    assert.equal(response.ok, false);
    assert.equal(writeActiveConfig.mock.callCount(), 0);
    assert.match(sendWebexMessage.mock.calls[0].arguments[0].markdown, /Configuration was not saved/);
    assert.equal(response.errors.length, 3);
  });

  test('validates submission ownership and reports an absent repository', async (t) => {
    const writeActiveConfig = t.mock.fn();
    const sendWebexMessage = t.mock.fn(async () => ({}));
    const loaded = loadWithMocks(require.resolve('../config/handle-submission'), {
      [require.resolve('../config/store')]: { writeActiveConfig },
      [require.resolve('../send')]: { sendWebexMessage },
    });
    t.after(loaded.restore);
    await assert.rejects(
      loaded.subject.handleConfigSubmission({ account: {} }),
      /action\.roomId is required/
    );
    await assert.rejects(
      loaded.subject.handleConfigSubmission({ action: { roomId: 'space-1' } }),
      /account is required/
    );

    const response = await loaded.subject.handleConfigSubmission({
      action: {
        roomId: 'space-1',
        inputs: {
          projectName: 'Project',
          githubRepo: '',
          responseMode: 'calibrated',
        },
      },
      account: { accountId: 'default', config: { token: 'bot-token' } },
      log: makeLog(t),
    });
    assert.deepEqual(response.errors, ['GitHub repository is required.']);
    assert.equal(writeActiveConfig.mock.callCount(), 0);
  });

  test('persists normalised valid input and sends confirmation', async (t) => {
    const writeActiveConfig = t.mock.fn(async () => ({ revision: 1 }));
    const sendWebexMessage = t.mock.fn(async () => ({ id: 'message-1' }));
    const loaded = loadWithMocks(require.resolve('../config/handle-submission'), {
      [require.resolve('../config/store')]: { writeActiveConfig },
      [require.resolve('../send')]: { sendWebexMessage },
    });
    t.after(loaded.restore);
    const action = {
      id: 'action-1',
      roomId: 'space-1',
      messageId: 'card-message',
      personId: 'person-1',
      inputs: {
        projectName: ' Project ',
        projectDescription: ' Description ',
        githubRepo: ' owner/repo ',
        responseMode: 'calibrated',
      },
    };

    const response = await loaded.subject.handleConfigSubmission({
      action,
      account: { accountId: 'default', config: { token: 'bot-token' } },
      log: makeLog(t),
    });

    assert.equal(response.ok, true);
    const writeArgs = writeActiveConfig.mock.calls[0].arguments[0];
    assert.deepEqual(writeArgs.config, {
      projectName: 'Project',
      projectDescription: 'Description',
      githubRepo: 'owner/repo',
      responseMode: 'calibrated',
    });
    assert.equal(writeArgs.source.actionId, 'action-1');
    assert.equal(writeArgs.source.submittedBy, 'person-1');
    assert.match(sendWebexMessage.mock.calls[0].arguments[0].markdown, /Configuration saved/);
  });

  test('loads active configuration and delegates adaptive-card sending', async (t) => {
    const active = { config: { projectName: 'Project' } };
    const readActiveConfig = t.mock.fn(async () => active);
    const sendConfigCard = t.mock.fn(async () => ({ ok: true }));
    const loaded = loadWithMocks(require.resolve('../config/handle-request'), {
      [require.resolve('../config/store')]: { readActiveConfig },
      [require.resolve('../config/card')]: { sendConfigCard },
    });
    t.after(loaded.restore);
    const log = makeLog(t);
    const requestAccount = { accountId: 'default' };

    await loaded.subject.handleConfigRequest({
      spaceId: 'space-1',
      account: requestAccount,
      log,
    });

    assert.deepEqual(sendConfigCard.mock.calls[0].arguments[0], {
      spaceId: 'space-1',
      account: requestAccount,
      log,
      config: active.config,
      sendFn: undefined,
    });
  });

  test('validates config requests and presents an empty card for a new space', async (t) => {
    const readActiveConfig = t.mock.fn(async () => null);
    const sendConfigCard = t.mock.fn(async () => ({ ok: true }));
    const loaded = loadWithMocks(require.resolve('../config/handle-request'), {
      [require.resolve('../config/store')]: { readActiveConfig },
      [require.resolve('../config/card')]: { sendConfigCard },
    });
    t.after(loaded.restore);
    await assert.rejects(
      loaded.subject.handleConfigRequest({ account: {} }),
      /spaceId is required/
    );
    await assert.rejects(
      loaded.subject.handleConfigRequest({ spaceId: 'space-1' }),
      /account is required/
    );
    const account = { accountId: 'default' };
    await loaded.subject.handleConfigRequest({
      spaceId: 'space-1',
      account,
      log: makeLog(t),
    });
    assert.deepEqual(sendConfigCard.mock.calls[0].arguments[0].config, {});
  });

  test('builds and sends the adaptive configuration card', async (t) => {
    const sendWebexMessage = t.mock.fn(async () => ({ id: 'card-1' }));
    const loaded = loadWithMocks(require.resolve('../config/card'), {
      [require.resolve('../api')]: { webexFetch: t.mock.fn() },
      [require.resolve('../send')]: { sendWebexMessage },
    });
    t.after(loaded.restore);

    const response = await loaded.subject.sendConfigCard({
      spaceId: 'space-1',
      account: { accountId: 'default', config: { token: 'bot-token' } },
      log: makeLog(t),
      config: {
        projectName: 'Project',
        projectDescription: 'Description',
        responseMode: 'direct_only',
        githubRepo: 'owner/repo',
      },
    });

    assert.equal(response.messageId, 'card-1');
    const request = sendWebexMessage.mock.calls[0].arguments[0];
    assert.equal(request.attachments[0].contentType,
      'application/vnd.microsoft.card.adaptive');
    const card = request.attachments[0].content;
    assert.equal(card.type, 'AdaptiveCard');
    assert.ok(card.body.some((field) => field.id === 'githubRepo' && field.value === 'owner/repo'));
    assert.equal(card.actions[0].data.action, 'submit_config');
  });

  test('validates card delivery inputs before sending', async (t) => {
    const sendWebexMessage = t.mock.fn();
    const loaded = loadWithMocks(require.resolve('../config/card'), {
      [require.resolve('../api')]: { webexFetch: t.mock.fn() },
      [require.resolve('../send')]: { sendWebexMessage },
    });
    t.after(loaded.restore);
    await assert.rejects(
      loaded.subject.sendConfigCard({ account: {} }),
      /spaceId is required/
    );
    await assert.rejects(
      loaded.subject.sendConfigCard({ spaceId: 'space-1' }),
      /account is required/
    );
    await assert.rejects(
      loaded.subject.sendConfigCard({
        spaceId: 'space-1',
        account: { accountId: 'default', config: {} },
      }),
      /Webex token is required/
    );
    assert.equal(sendWebexMessage.mock.callCount(), 0);
  });
});

// Category: Attachment-action ingress.
// These tests verify action IDs are required, supported configuration actions are dispatched, and unknown actions are logged without mutation.
describe('attachment-action ingress', () => {
  test('handles missing, supported, and unknown attachment actions', async (t) => {
    const actions = new Map([
      ['action-submit', {
        id: 'action-submit',
        roomId: 'space-1',
        messageId: 'card-1',
        inputs: { action: 'submit_config' },
      }],
      ['action-unknown', {
        id: 'action-unknown',
        roomId: 'space-1',
        inputs: { action: 'unknown' },
      }],
    ]);
    const webexFetch = t.mock.fn(async (_token, apiPath) =>
      actions.get(apiPath.split('/').at(-1))
    );
    const handleConfigSubmission = t.mock.fn(async () => ({ ok: true }));
    const loaded = loadWithMocks(require.resolve('../inbound/attachment-actions'), {
      [require.resolve('../api')]: { webexFetch },
      [require.resolve('../token')]: { getAccessToken: t.mock.fn() },
      [require.resolve('../config/handle-submission')]: { handleConfigSubmission },
    });
    t.after(loaded.restore);
    const log = makeLog(t);
    const context = {
      cfg: { token: 'bot-token' },
      account: { accountId: 'default' },
      log,
    };

    await loaded.subject.handleInboundWebexAttachmentAction(
      { resource: 'attachmentActions', event: 'created', data: {} },
      context
    );
    await loaded.subject.handleInboundWebexAttachmentAction(
      { resource: 'attachmentActions', event: 'created', data: { id: 'action-submit' } },
      context
    );
    await loaded.subject.handleInboundWebexAttachmentAction(
      { resource: 'attachmentActions', event: 'created', data: { id: 'action-unknown' } },
      context
    );

    assert.equal(webexFetch.mock.callCount(), 2);
    assert.equal(handleConfigSubmission.mock.callCount(), 1);
    assert.ok(mockCalls(log.warn).some(([text]) => text.includes('missing id')));
    assert.ok(mockCalls(log.warn).some(([text]) => text.includes('unknown attachment')));
  });
});

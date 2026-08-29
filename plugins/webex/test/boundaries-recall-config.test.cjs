'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { loadWithMocks, makeLog, mockCalls } = require('./helpers.cjs');

// resolveReplyThreadId's own correctness (main vs. existing thread, the
// root-mention lookup) is covered directly in test/send-outbound.test.cjs
// against real storage. Mocked here to the same simple contract — these
// tests are about sendConfigCard/handleConfigSubmission's own wiring, not
// re-deriving that logic.
async function resolveReplyThreadId({ threadKey, message, isBotMentioned }) {
  if (!isBotMentioned) return null;
  return threadKey === '__main__' ? message?.id : threadKey;
}

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

  // OpenClaw core's durable delivery queue (e.g. the restart-sentinel notice)
  // passes targets as `webex:<id>` — an unstripped prefix corrupts the
  // base64 decode and gets sent to Webex as a literal roomId, which 404s.
  test('strips a leading webex: channel prefix from room, person, and email targets', () => {
    const { buildMsgBody } = require('../send');
    const personId = Buffer.from('ciscospark://us/PEOPLE/person-1').toString('base64');

    assert.deepEqual(buildMsgBody('webex:room-id', { text: 'Hello' }), {
      roomId: 'room-id',
      text: 'Hello',
    });
    assert.deepEqual(buildMsgBody(`webex:${personId}`, { text: 'Hi' }), {
      toPersonId: personId,
      text: 'Hi',
    });
    assert.deepEqual(
      buildMsgBody('WEBEX:person@example.com', { text: 'Hi' }),
      { toPersonEmail: 'person@example.com', text: 'Hi' }
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

// Category: Configuration submission and card flow.
// These tests verify invalid submissions receive actionable feedback and valid submissions are persisted, acknowledged, and redisplayed through the config route.
describe('configuration submission and card flow', () => {
  test('rejects invalid fields without writing configuration', async (t) => {
    const writeActiveConfig = t.mock.fn();
    const sendOutboundMessage = t.mock.fn(async () => ({ id: 'message-1' }));
    const loaded = loadWithMocks(require.resolve('../config/handle-submission'), {
      [require.resolve('../config/store')]: { writeActiveConfig },
      [require.resolve('../send')]: { sendOutboundMessage },
    });
    t.after(loaded.restore);

    const response = await loaded.subject.handleConfigSubmission({
      action: {
        roomId: 'space-1',
        messageId: 'card-message',
        inputs: {
          projectName: '',
          githubRepo: 'bad repo',
          responseMode: 'unknown',
          replyThreadId: 'thread-root-1',
        },
      },
      account: { accountId: 'default', config: { token: 'bot-token' } },
      botId: 'bot-1',
      log: makeLog(t),
    });

    assert.equal(response.ok, false);
    assert.equal(writeActiveConfig.mock.callCount(), 0);
    assert.match(sendOutboundMessage.mock.calls[0].arguments[0].markdown, /Configuration was not saved/);
    assert.equal(response.errors.length, 3);
    // The card message is itself always a reply (config/card.js) — Webex
    // rejects a reply to a reply, so this must thread under the original
    // root (replyThreadId), never the card's own message id.
    assert.equal(sendOutboundMessage.mock.calls[0].arguments[0].parentId, 'thread-root-1');
    // Confirmation/error messages must be recorded to the thread window
    // like every other sender — this was a real gap (handleConfigSubmission
    // used to call the bare sendWebexMessage, skipping recording entirely).
    assert.equal(sendOutboundMessage.mock.calls[0].arguments[0].spaceId, 'space-1');
    assert.equal(sendOutboundMessage.mock.calls[0].arguments[0].botId, 'bot-1');
  });

  test('posts as a top-level message (no parentId) when replyThreadId is absent — a card opened before this fix deployed', async (t) => {
    const writeActiveConfig = t.mock.fn();
    const sendOutboundMessage = t.mock.fn(async () => ({ id: 'message-1' }));
    const loaded = loadWithMocks(require.resolve('../config/handle-submission'), {
      [require.resolve('../config/store')]: { writeActiveConfig },
      [require.resolve('../send')]: { sendOutboundMessage },
    });
    t.after(loaded.restore);

    await loaded.subject.handleConfigSubmission({
      action: {
        roomId: 'space-1',
        messageId: 'card-message',
        inputs: { projectName: '', githubRepo: 'bad repo' },
      },
      account: { accountId: 'default', config: { token: 'bot-token' } },
      botId: 'bot-1',
      log: makeLog(t),
    });

    // NOT action.messageId — the card is unconditionally a reply, so that
    // would 400 the same way. send.js only sets parentId when truthy, so
    // undefined here means it posts as an ordinary top-level message.
    assert.equal(sendOutboundMessage.mock.calls[0].arguments[0].parentId, undefined);
  });

  test('validates submission ownership and reports an absent repository', async (t) => {
    const writeActiveConfig = t.mock.fn();
    const readActiveConfig = t.mock.fn(async () => ({ members: [] }));
    const sendOutboundMessage = t.mock.fn(async () => ({}));
    const loaded = loadWithMocks(require.resolve('../config/handle-submission'), {
      [require.resolve('../config/store')]: { writeActiveConfig, readActiveConfig },
      [require.resolve('../send')]: { sendOutboundMessage },
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
          proactivityThreshold: '0.7',
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
    const readActiveConfig = t.mock.fn(async () => ({ members: [] }));
    const sendOutboundMessage = t.mock.fn(async () => ({ id: 'message-1' }));
    const loaded = loadWithMocks(require.resolve('../config/handle-submission'), {
      [require.resolve('../config/store')]: { writeActiveConfig, readActiveConfig },
      [require.resolve('../send')]: { sendOutboundMessage },
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
        proactivityThreshold: '0.7',
        replyThreadId: 'thread-root-1',
      },
    };

    const response = await loaded.subject.handleConfigSubmission({
      action,
      account: { accountId: 'default', config: { token: 'bot-token' } },
      botId: 'bot-1',
      log: makeLog(t),
    });

    assert.equal(response.ok, true);
    const writeArgs = writeActiveConfig.mock.calls[0].arguments[0];
    assert.deepEqual(writeArgs.config, {
      projectName: 'Project',
      projectDescription: 'Description',
      githubRepo: 'owner/repo',
      proactivityThreshold: 0.7,
    });
    assert.equal(writeArgs.source.actionId, 'action-1');
    assert.equal(writeArgs.source.submittedBy, 'person-1');
    assert.match(sendOutboundMessage.mock.calls[0].arguments[0].markdown, /Configuration saved/);
    // Same reply-to-a-reply concern as the rejection path — the confirmation
    // must thread under the original root, not the card's own message id.
    assert.equal(sendOutboundMessage.mock.calls[0].arguments[0].parentId, 'thread-root-1');
    // Confirmation messages must be recorded to the thread window like
    // every other sender — this was a real gap before this fix.
    assert.equal(sendOutboundMessage.mock.calls[0].arguments[0].spaceId, 'space-1');
    assert.equal(sendOutboundMessage.mock.calls[0].arguments[0].botId, 'bot-1');
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
    const triggeringMessage = { id: 'msg-1' };

    await loaded.subject.handleConfigRequest({
      spaceId: 'space-1',
      threadKey: '__main__',
      message: triggeringMessage,
      isBotMentioned: true,
      account: requestAccount,
      botId: 'bot-1',
      log,
    });

    assert.deepEqual(sendConfigCard.mock.calls[0].arguments[0], {
      spaceId: 'space-1',
      threadKey: '__main__',
      message: triggeringMessage,
      isBotMentioned: true,
      account: requestAccount,
      botId: 'bot-1',
      log,
      config: active.config,
      members: [],
      sendFn: undefined,
    });
  });

  // Manual testing surfaced this: the bot is technically a Webex member of
  // its own space, so an unfiltered membership fetch put it on the config
  // card as an editable "member" — and, more seriously, into extract's own
  // "Space members" list alongside config/members.js's synthetic
  // AGENT_ASSIGNEE ({id: 'agent'}), risking `assigned` landing on the bot's
  // real personId instead of the 'agent' sentinel write_task's
  // auto-approval check looks for.
  test('excludes the bot\'s own membership when refreshing the member cache', async (t) => {
    const webexFetch = t.mock.fn(async () => ({
      items: [
        { personId: 'person-1', personEmail: 'ada@example.com', personDisplayName: 'Ada' },
        { personId: 'bot-1', personEmail: 'collab-agent@webex.bot', personDisplayName: 'collab-agent' },
      ],
    }));
    const readActiveConfig = t.mock.fn(async () => null);
    const writeCachedMembers = t.mock.fn(async () => undefined);
    const sendConfigCard = t.mock.fn(async () => ({ ok: true }));
    const loaded = loadWithMocks(require.resolve('../config/handle-request'), {
      [require.resolve('../api')]: { webexFetch },
      [require.resolve('../config/store')]: { readActiveConfig, writeCachedMembers },
      [require.resolve('../config/card')]: { sendConfigCard },
    });
    t.after(loaded.restore);

    await loaded.subject.handleConfigRequest({
      spaceId: 'space-1',
      account: { accountId: 'default', config: { token: 'bot-token' } },
      botId: 'bot-1',
      log: makeLog(t),
    });

    const members = sendConfigCard.mock.calls[0].arguments[0].members;
    assert.equal(members.length, 1);
    assert.equal(members[0].id, 'person-1');
    assert.deepEqual(
      writeCachedMembers.mock.calls[0].arguments[0].members.map((m) => m.id),
      ['person-1']
    );
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

  test('builds and sends the adaptive configuration card, threaded under the triggering message', async (t) => {
    const sendWebexMessage = t.mock.fn(async () => ({ id: 'card-1' }));
    const loaded = loadWithMocks(require.resolve('../config/card'), {
      [require.resolve('../api')]: { webexFetch: t.mock.fn() },
      [require.resolve('../send')]: { sendWebexMessage, resolveReplyThreadId, resolveOutboundSender: ({ sendFn }) => sendFn ?? sendWebexMessage },
    });
    t.after(loaded.restore);

    const response = await loaded.subject.sendConfigCard({
      spaceId: 'space-1',
      threadKey: '__main__',
      message: { id: 'msg-1' },
      isBotMentioned: true,
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
    // Main-space request → threads under the triggering message, same
    // convention every other sender uses (task-notify, thinking-ack).
    assert.equal(request.parentId, 'msg-1');
    const card = request.attachments[0].content;
    assert.equal(card.type, 'AdaptiveCard');
    assert.ok(card.body.some((field) => field.id === 'githubRepo' && field.value === 'owner/repo'));
    assert.equal(card.actions[0].data.action, 'submit_config');
    // Round-trips back as action.inputs.replyThreadId on submission — the
    // fix for "Cannot reply to a reply" (the card message is itself always
    // a reply, so the submission handler needs this, not its own id).
    assert.equal(card.actions[0].data.replyThreadId, 'msg-1');
  });

  // Webex bots can only see messages that @-mention them — a platform
  // restriction, not a bug (see send.js's resolveReplyThreadId). Threading
  // this card under a message the bot never saw would 400 with "Cannot
  // reply to a reply" (it's always a reply — see the fix above); posting
  // bare in the main space is the correct, safe fallback, and its own
  // submit data must also carry no replyThreadId, so a later submission
  // doesn't independently hit the same wall.
  test('posts the card with no parentId when the bot was not actually @-mentioned', async (t) => {
    const sendWebexMessage = t.mock.fn(async () => ({ id: 'card-1' }));
    const loaded = loadWithMocks(require.resolve('../config/card'), {
      [require.resolve('../api')]: { webexFetch: t.mock.fn() },
      [require.resolve('../send')]: { sendWebexMessage, resolveReplyThreadId, resolveOutboundSender: ({ sendFn }) => sendFn ?? sendWebexMessage },
    });
    t.after(loaded.restore);

    await loaded.subject.sendConfigCard({
      spaceId: 'space-1',
      threadKey: '__main__',
      message: { id: 'msg-1' },
      isBotMentioned: false,
      account: { accountId: 'default', config: { token: 'bot-token' } },
      log: makeLog(t),
      config: {},
    });

    const request = sendWebexMessage.mock.calls[0].arguments[0];
    assert.equal(request.parentId, null);
    const card = request.attachments[0].content;
    assert.equal(card.actions[0].data.replyThreadId, null);
  });

  test('threads the config card under threadKey when the request came from an existing thread', async (t) => {
    const sendWebexMessage = t.mock.fn(async () => ({ id: 'card-1' }));
    const loaded = loadWithMocks(require.resolve('../config/card'), {
      [require.resolve('../api')]: { webexFetch: t.mock.fn() },
      [require.resolve('../send')]: { sendWebexMessage, resolveReplyThreadId, resolveOutboundSender: ({ sendFn }) => sendFn ?? sendWebexMessage },
    });
    t.after(loaded.restore);

    await loaded.subject.sendConfigCard({
      spaceId: 'space-1',
      threadKey: 'thread-root-1',
      message: { id: 'msg-2' },
      isBotMentioned: true,
      account: { accountId: 'default', config: { token: 'bot-token' } },
      log: makeLog(t),
      config: {},
    });

    const request = sendWebexMessage.mock.calls[0].arguments[0];
    assert.equal(request.parentId, 'thread-root-1');
    const card = request.attachments[0].content;
    assert.equal(card.actions[0].data.replyThreadId, 'thread-root-1');
  });

  test('validates card delivery inputs before sending', async (t) => {
    const sendWebexMessage = t.mock.fn();
    const loaded = loadWithMocks(require.resolve('../config/card'), {
      [require.resolve('../api')]: { webexFetch: t.mock.fn() },
      [require.resolve('../send')]: { sendWebexMessage, resolveReplyThreadId, resolveOutboundSender: ({ sendFn }) => sendFn ?? sendWebexMessage },
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
      botId: 'bot-1',
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
    // botId must reach handleConfigSubmission so its confirmation/error
    // messages can be recorded to the thread window like every other
    // sender (config/handle-submission.js's sendOutboundMessage).
    assert.equal(handleConfigSubmission.mock.calls[0].arguments[0].botId, 'bot-1');
    assert.ok(mockCalls(log.warn).some(([text]) => text.includes('missing id')));
    assert.ok(mockCalls(log.warn).some(([text]) => text.includes('unknown attachment')));
  });
});

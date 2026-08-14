'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { makeTempWorkspace } = require('./helpers.cjs');
const { setPluginRuntime } = require('../runtime');
const { makeRouteResultHandler } = require('../routing/result-handler');
const { getConversations } = require('../context/conversations-store');
const { getItems } = require('../context/items-store');

async function waitFor(predicate, timeoutMs = 4_000) {
  const deadline = Date.now() + timeoutMs;
  let lastValue;

  while (Date.now() < deadline) {
    lastValue = await predicate();
    if (lastValue) return lastValue;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  throw new Error(`condition was not met within ${timeoutMs}ms`);
}

// Category: Joined main Webex processing pipeline.
// This test verifies a task route moves one real message through durable batching, conversation processing, grounded item extraction, and persisted project context.
describe('joined main Webex processing pipeline', () => {
  test('turns a routed task message into stored conversation and item context', async (t) => {
    const root = await makeTempWorkspace(t);
    const previousRoot = process.env.OPENCLAW_WORKSPACE_DIR;
    process.env.OPENCLAW_WORKSPACE_DIR = root;
    t.after(() => {
      setPluginRuntime(null);
      if (previousRoot === undefined) delete process.env.OPENCLAW_WORKSPACE_DIR;
      else process.env.OPENCLAW_WORKSPACE_DIR = previousRoot;
    });
    t.mock.method(console, 'log', () => undefined);
    t.mock.method(console, 'warn', () => undefined);

    const sessions = [];
    const runtime = {
      config: { current: () => ({ agents: { defaults: {} } }) },
      channel: {
        reply: {
          dispatchReplyWithBufferedBlockDispatcher: async (options) => {
            sessions.push(options.ctx.SessionKey);

            if (options.ctx.SessionKey.includes(':conv-processing')) {
              await options.dispatcherOptions.deliver({
                text: JSON.stringify({
                  conversationUpdates: [],
                  newConversations: [
                    {
                      topic: 'Login test failure',
                      summary: 'The team needs to fix the failing login test.',
                      messageIds: ['message-1'],
                    },
                  ],
                  untrackedMessageIds: [],
                  responseDecision: {
                    needed: false,
                    reason: 'Task is recorded for processing.',
                    message: null,
                    replyToId: null,
                  },
                }),
              });
              return;
            }

            if (options.ctx.SessionKey.includes(':item-extraction')) {
              const conversationId = options.ctx.CommandBody.match(
                /"id": "(conv_[^"]+)"/
              )?.[1];
              assert.ok(conversationId, 'item prompt should contain the created conversation');
              await options.dispatcherOptions.deliver({
                text: JSON.stringify({
                  itemUpdates: [],
                  newItems: [
                    {
                      type: 'task',
                      status: 'open',
                      title: 'Fix login test',
                      description: 'Repair the failing login test before release.',
                      owner: null,
                      conversationIds: [conversationId],
                      evidenceMessageIds: ['message-1'],
                    },
                  ],
                }),
              });
              return;
            }

            throw new Error(`unexpected session ${options.ctx.SessionKey}`);
          },
        },
      },
    };
    setPluginRuntime(runtime);

    const message = {
      id: 'message-1',
      roomId: 'space-1',
      roomType: 'group',
      personId: 'person-1',
      personEmail: 'developer@example.com',
      text: 'Please fix the failing login test',
      created: '2026-08-14T09:00:00.000Z',
      receivedAt: '2026-08-14T09:00:00.000Z',
    };

    await makeRouteResultHandler({
      message,
      account: { accountId: 'default', config: { token: 'bot-token' } },
      log: { info() {}, warn() {}, error() {} },
    })({
      text: JSON.stringify({
        routes: [{ route: 'task_request', reason: 'Explicit implementation request' }],
      }),
    });

    const storedItems = await waitFor(async () => {
      const items = await getItems({ spaceId: 'space-1' });
      return items.length > 0 ? items : null;
    });
    const storedConversations = await getConversations({
      spaceId: 'space-1',
      statuses: ['active'],
    });

    assert.equal(storedConversations.length, 1);
    assert.equal(storedConversations[0].topic, 'Login test failure');
    assert.deepEqual(storedConversations[0].lastMessageIds, ['message-1']);
    assert.equal(storedItems.length, 1);
    assert.equal(storedItems[0].title, 'Fix login test');
    assert.equal(storedItems[0].status, 'open');
    assert.deepEqual(storedItems[0].evidenceMessageIds, ['message-1']);
    assert.deepEqual(storedItems[0].conversationIds, [storedConversations[0].id]);
    assert.deepEqual(sessions, [
      'agent:main:webex:space-1:conv-processing',
      'agent:main:webex:space-1:item-extraction',
    ]);
  });
});

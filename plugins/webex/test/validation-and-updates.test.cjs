'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const {
  validateConversationProcessingResult,
} = require('../processing/conversations/validate-result');
const {
  validateItemExtractionResult,
} = require('../processing/items/validate-result');
const {
  applyItemExtractionResult,
  updateItemsFromResult,
} = require('../processing/items/update-from-result');
const {
  updateConversationsFromResult,
} = require('../processing/conversations/update-from-result');
const { loadWithMocks } = require('./helpers.cjs');

const processingBatch = {
  spaceId: 'space-1',
  batchId: 'batch-1',
  messages: [{ id: 'message-1' }, { id: 'message-2' }],
};

// Category: Conversation-result validation.
// These tests verify valid conversation decisions pass and every ungrounded identifier or malformed response is rejected.
describe('conversation-result validation', () => {
  test('accepts a fully grounded conversation result', () => {
    const errors = validateConversationProcessingResult(
      {
        conversationUpdates: [
          { conversationId: 'conv-1', summary: 'Updated', messageIds: ['message-1'] },
        ],
        newConversations: [
          { topic: 'New topic', summary: 'New summary', messageIds: ['message-2'] },
        ],
        untrackedMessageIds: [],
        responseDecision: { needed: false, message: null, replyToId: null },
      },
      { processingBatch, existingConversations: [{ id: 'conv-1' }] }
    );

    assert.deepEqual(errors, []);
  });

  test('reports malformed shapes, unknown IDs, and missing summaries', () => {
    const errors = validateConversationProcessingResult(
      {
        conversationUpdates: [
          { conversationId: 'missing-conv', summary: ' ', messageIds: ['missing-message'] },
        ],
        newConversations: [
          { topic: '', summary: '', messageIds: ['missing-message'] },
        ],
        untrackedMessageIds: ['missing-message'],
        responseDecision: { needed: 'yes' },
      },
      { processingBatch, existingConversations: [{ id: 'conv-1' }] }
    );

    assert.ok(errors.some((error) => error.includes('unknown conversationId')));
    assert.ok(errors.some((error) => error.includes('unknown messageId')));
    assert.ok(errors.some((error) => error.includes('missing summary')));
    assert.ok(errors.some((error) => error.includes('missing topic')));
    assert.ok(errors.some((error) => error.includes('needed must be a boolean')));
  });

  test('rejects non-object and missing-array results', () => {
    assert.deepEqual(
      validateConversationProcessingResult(null, {
        processingBatch,
        existingConversations: [],
      }),
      ['result must be a JSON object']
    );

    const errors = validateConversationProcessingResult(
      { responseDecision: { needed: false } },
      { processingBatch, existingConversations: [] }
    );
    assert.equal(errors.filter((error) => error.includes('must be an array')).length, 3);
  });
});

// Category: Item-result validation.
// These tests verify item changes are restricted to known messages, touched conversations, supported types, and supported statuses.
describe('item-result validation', () => {
  test('rejects non-object output, missing arrays, and absent batch context', () => {
    assert.deepEqual(
      validateItemExtractionResult(null, {
        processingBatch,
        touchedConversations: [],
        candidateItems: [],
      }),
      ['itemExtractionResult must be a JSON object']
    );
    const errors = validateItemExtractionResult(
      {},
      {
        processingBatch: null,
        touchedConversations: null,
        candidateItems: null,
      }
    );
    assert.ok(errors.includes('processingBatch is required'));
    assert.ok(errors.includes('itemUpdates must be an array'));
    assert.ok(errors.includes('newItems must be an array'));
  });

  test('accepts grounded updates and new items', () => {
    const errors = validateItemExtractionResult(
      {
        itemUpdates: [
          {
            itemId: 'item-1',
            status: 'resolved',
            conversationIds: ['conv-1'],
            evidenceMessageIds: ['message-1'],
          },
        ],
        newItems: [
          {
            type: 'task',
            status: 'open',
            title: 'Ship release',
            description: 'Publish the release',
            conversationIds: ['conv-1'],
            evidenceMessageIds: ['message-2'],
          },
        ],
      },
      {
        processingBatch,
        touchedConversations: [{ id: 'conv-1' }],
        candidateItems: [{ id: 'item-1' }],
      }
    );

    assert.deepEqual(errors, []);
  });

  test('reports unsupported fields and ungrounded identifiers', () => {
    const errors = validateItemExtractionResult(
      {
        itemUpdates: [
          {
            itemId: 'missing-item',
            status: 'invalid',
            conversationIds: ['missing-conv'],
            evidenceMessageIds: ['missing-message'],
          },
        ],
        newItems: [
          {
            type: 'invalid',
            status: 'invalid',
            title: ' ',
            description: '',
            conversationIds: [],
            evidenceMessageIds: [],
          },
        ],
      },
      {
        processingBatch,
        touchedConversations: [{ id: 'conv-1' }],
        candidateItems: [{ id: 'item-1' }],
      }
    );

    for (const fragment of [
      'unknown itemId',
      'invalid item update status',
      'unknown evidenceMessageId',
      'unknown conversationId',
      'invalid new item type',
      'invalid new item status',
      'missing title',
      'missing description',
      'missing evidenceMessageIds',
      'missing conversationIds',
    ]) {
      assert.ok(errors.some((error) => error.includes(fragment)), fragment);
    }
  });
});

// Category: Item-state transformation.
// These tests verify updates preserve unspecified data, merge evidence without duplicates, ignore unknown items, and create normalised records.
describe('item-state transformation', () => {
  test('updates existing items and creates new items without mutating input state', () => {
    const state = {
      schemaVersion: 1,
      items: [
        {
          id: 'item-1',
          type: 'task',
          status: 'open',
          title: 'Old title',
          description: 'Old description',
          owner: 'Alice',
          conversationIds: ['conv-1'],
          evidenceMessageIds: ['message-1'],
        },
      ],
    };

    const result = applyItemExtractionResult({
      state,
      result: {
        itemUpdates: [
          {
            itemId: 'item-1',
            status: 'resolved',
            title: null,
            description: ' Done ',
            owner: null,
            conversationIds: ['conv-1', 'conv-2'],
            evidenceMessageIds: ['message-1', 'message-2'],
          },
          { itemId: 'unknown', status: 'blocked' },
        ],
        newItems: [
          {
            type: ' risk ',
            status: '',
            title: ' New risk ',
            description: ' Description ',
            conversationIds: ['conv-2', 'conv-2'],
            evidenceMessageIds: ['message-2', 'message-2'],
          },
        ],
      },
    });

    assert.equal(state.items[0].status, 'open');
    assert.equal(result.newState.items[0].status, 'resolved');
    assert.equal(result.newState.items[0].title, 'Old title');
    assert.equal(result.newState.items[0].description, 'Done');
    assert.equal(result.newState.items[0].owner, 'Alice');
    assert.deepEqual(result.newState.items[0].conversationIds, ['conv-1', 'conv-2']);
    assert.deepEqual(result.newState.items[0].evidenceMessageIds, ['message-1', 'message-2']);

    const created = result.newState.items[1];
    assert.match(created.id, /^item_/);
    assert.equal(created.type, 'risk');
    assert.equal(created.status, 'open');
    assert.equal(created.title, 'New risk');
    assert.deepEqual(created.conversationIds, ['conv-2']);
    assert.deepEqual(result.touchedItemIds, ['item-1', created.id]);
  });
});

// Category: Conversation-state persistence orchestration.
// These tests verify processing results are read, transformed, and written through the conversation store with the expected touched IDs.
describe('conversation-state persistence orchestration', () => {
  test('validates update prerequisites before reading state', async () => {
    const conversationResult = {
      conversationUpdates: [],
      newConversations: [],
      untrackedMessageIds: [],
      responseDecision: { needed: false },
    };
    const itemResult = { itemUpdates: [], newItems: [] };
    const account = { accountId: 'default' };

    const conversationCases = [
      [{ conversationProcessingResult: conversationResult, account }, /processingBatch is required/],
      [{ processingBatch: {}, conversationProcessingResult: conversationResult, account }, /processingBatch\.spaceId is required/],
      [{ processingBatch, account }, /conversationProcessingResult is required/],
      [{ processingBatch, conversationProcessingResult: conversationResult }, /account is required/],
    ];
    for (const [input, expected] of conversationCases) {
      await assert.rejects(updateConversationsFromResult(input), expected);
    }

    const itemCases = [
      [{ itemExtractionResult: itemResult, account }, /processingBatch is required/],
      [{ processingBatch: {}, itemExtractionResult: itemResult, account }, /processingBatch\.spaceId is required/],
      [{ processingBatch, account }, /itemExtractionResult is required/],
      [{ processingBatch, itemExtractionResult: itemResult }, /account is required/],
    ];
    for (const [input, expected] of itemCases) {
      await assert.rejects(updateItemsFromResult(input), expected);
    }
  });

  test('updates an existing conversation and persists the resulting state', async (t) => {
    const readConversationsState = t.mock.fn(async () => ({
      schemaVersion: 1,
      conversations: [
        {
          id: 'conv-1',
          topic: 'Release',
          summary: 'Old',
          status: 'dormant',
          lastMessageIds: ['old-message'],
        },
      ],
    }));
    const writeConversationsState = t.mock.fn(async ({ state }) => state);
    const storeId = require.resolve('../context/conversations-store');
    const loaded = loadWithMocks(
      require.resolve('../processing/conversations/update-from-result'),
      {
        [storeId]: { readConversationsState, writeConversationsState },
      }
    );
    t.after(loaded.restore);

    const response = await loaded.subject.updateConversationsFromResult({
      processingBatch,
      conversationProcessingResult: {
        conversationUpdates: [
          { conversationId: 'conv-1', summary: ' Updated ', messageIds: ['message-1'] },
        ],
        newConversations: [],
        untrackedMessageIds: ['message-2'],
        responseDecision: { needed: false },
      },
      account: { accountId: 'default' },
      log: { info: t.mock.fn() },
    });

    assert.deepEqual(response.touchedConversationIds, ['conv-1']);
    const written = writeConversationsState.mock.calls[0].arguments[0].state;
    assert.equal(written.conversations[0].summary, 'Updated');
    assert.equal(written.conversations[0].status, 'active');
    assert.deepEqual(written.conversations[0].lastMessageIds, ['old-message', 'message-1']);
  });
});

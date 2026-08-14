'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { asArray, cleanString, unique } = require('./utils/normalise');
const { parseJsonObjectFromText } = require('./utils/parse-json');
const { buildRoutingInstruction } = require('./routing/instruction');
const {
  buildConversationProcessingInstruction,
} = require('./processing/conversations/instruction');
const {
  buildItemExtractionInstruction,
} = require('./processing/items/instruction');
const { buildRecallInstruction } = require('./recall/instruction');

// Category: Normalisation helpers.
// These tests verify defensive handling of arrays, strings, duplicates, and falsey values used throughout the pipeline.
describe('normalisation helpers', () => {
  test('normalises arrays and strings without mutating valid values', () => {
    const values = ['a', 'a', '', null, 'b'];

    assert.deepEqual(asArray(values), values);
    assert.deepEqual(asArray('not-an-array'), []);
    assert.equal(cleanString('  project  '), 'project');
    assert.equal(cleanString(42), '');
    assert.deepEqual(unique(values), ['a', 'b']);
  });
});

// Category: LLM JSON parsing.
// These tests verify every accepted response envelope and ensure malformed or missing model output is rejected.
describe('LLM JSON parsing', () => {
  test('parses strict, fenced, and embedded JSON objects', () => {
    assert.deepEqual(parseJsonObjectFromText('{"routes":[]}'), { routes: [] });
    assert.deepEqual(
      parseJsonObjectFromText('```json\n{"ok":true}\n```'),
      { ok: true }
    );
    assert.deepEqual(
      parseJsonObjectFromText('Model preface {"itemUpdates":[]} trailing text'),
      { itemUpdates: [] }
    );
  });

  test('rejects absent text and text without a valid JSON object', () => {
    assert.throws(() => parseJsonObjectFromText(), /text is required/);
    assert.throws(() => parseJsonObjectFromText('nothing useful'), /No JSON object/);
    assert.throws(() => parseJsonObjectFromText('```json\n{bad}\n```'));
  });
});

// Category: Routing prompt construction.
// These tests verify that the classifier receives current-message metadata and only prior messages from the selected thread.
describe('routing instruction', () => {
  test('serialises message metadata, mention state, and thread context', () => {
    const instruction = buildRoutingInstruction({
      message: {
        roomId: 'space-1',
        text: 'Please fix the failing test',
        personEmail: 'dev@example.com',
        mentionedPeople: ['bot-1'],
        threadKey: 'root-1',
      },
      botId: 'bot-1',
      thread: {
        key: 'root-1',
        kind: 'webex_thread',
        rootMessageId: 'root-1',
        contextWindow: [
          { text: 'Earlier context', senderName: 'Alice', createdAt: '2026-01-01' },
        ],
      },
    });

    assert.match(instruction, /Please fix the failing test/);
    assert.match(instruction, /"botIsMentioned": true/);
    assert.match(instruction, /"rootMessageId": "root-1"/);
    assert.match(instruction, /Earlier context/);
    assert.match(instruction, /Return multiple routes/);
  });

  test('uses stable empty defaults when optional message and thread data is absent', () => {
    const instruction = buildRoutingInstruction({
      message: { roomId: 'space-1', personId: 'person-1' },
      botId: 'bot-1',
      thread: { contextWindow: 'invalid' },
    });

    assert.match(instruction, /"senderName": "person-1"/);
    assert.match(instruction, /"botIsMentioned": false/);
    assert.match(instruction, /"threadKey": null/);
    assert.match(instruction, /"key": null/);
    assert.match(instruction, /"contextWindow": \[\]/);
  });
});

// Category: Conversation-processing prompt construction.
// These tests verify that batches and existing conversation summaries are faithfully supplied to the conversation model.
describe('conversation-processing instruction', () => {
  test('serialises batch metadata, messages, and existing conversations', () => {
    const instruction = buildConversationProcessingInstruction({
      batch: {
        spaceId: 'space-1',
        batchId: 'batch-1',
        messageCount: 1,
        suggestedReplyToId: 'message-1',
        messages: [
          { id: 'message-1', text: 'Ship it', personEmail: 'a@example.com' },
        ],
      },
      conversations: [
        { id: 'conv-1', topic: 'Release', summary: 'Preparing release', status: 'active' },
      ],
    });

    assert.match(instruction, /"batchId": "batch-1"/);
    assert.match(instruction, /Ship it/);
    assert.match(instruction, /"senderName": "a@example.com"/);
    assert.match(instruction, /Preparing release/);
    assert.match(instruction, /responseDecision/);
  });

  test('normalises missing message fields and non-array collections', () => {
    const instruction = buildConversationProcessingInstruction({
      batch: {
        spaceId: 'space-1',
        batchId: 'batch-1',
        messageCount: 1,
        messages: [
          { id: 'message-1', personId: 'person-1' },
          { id: 'message-2', senderName: 'Alice', parentId: 'root-1' },
        ],
      },
      conversations: null,
    });

    assert.match(instruction, /"text": ""/);
    assert.match(instruction, /"senderName": "person-1"/);
    assert.match(instruction, /"senderName": "Alice"/);
    assert.match(instruction, /"parentId": "root-1"/);
    assert.match(instruction, /## Existing conversations[\s\S]*\[\]/);
  });
});

// Category: Item-extraction prompt construction.
// These tests verify the model sees only the staged batch, touched conversations, and candidate items needed for grounded extraction.
describe('item-extraction instruction', () => {
  test('serialises grounded messages, conversations, and candidate items', () => {
    const instruction = buildItemExtractionInstruction({
      processingBatch: {
        spaceId: 'space-1',
        batchId: 'batch-1',
        messageCount: 1,
        messages: [{ id: 'message-1', text: 'Fix login', personId: 'person-1' }],
      },
      touchedConversations: [
        { id: 'conv-1', topic: 'Login', summary: 'Login is broken', status: 'active' },
      ],
      candidateItems: [
        {
          id: 'item-1',
          type: 'issue',
          status: 'open',
          title: 'Login failure',
          description: 'Users cannot sign in',
          conversationIds: ['conv-1'],
        },
      ],
    });

    assert.match(instruction, /Fix login/);
    assert.match(instruction, /Login is broken/);
    assert.match(instruction, /Login failure/);
    assert.match(instruction, /Every new item must have at least one evidenceMessageId/);
  });

  test('normalises absent optional fields and invalid context collections', () => {
    const instruction = buildItemExtractionInstruction({
      processingBatch: {
        spaceId: 'space-1',
        batchId: 'batch-1',
        messageCount: 1,
        messages: [{ id: 'message-1', senderName: 'Alice' }],
      },
      touchedConversations: null,
      candidateItems: [
        {
          id: 'item-1',
          type: 'task',
          status: 'open',
          title: 'Task',
          description: 'Description',
          conversationIds: 'invalid',
        },
      ],
    });

    assert.match(instruction, /"text": ""/);
    assert.match(instruction, /"senderName": "Alice"/);
    assert.match(instruction, /"owner": null/);
    assert.match(instruction, /"conversationIds": \[\]/);
    assert.match(instruction, /## Included conversations[\s\S]*\[\]/);
  });
});

// Category: Recall prompt construction.
// These tests verify that recall answers are constrained to the current question and the stored project context.
describe('recall instruction', () => {
  test('serialises the current question, conversations, and items', () => {
    const instruction = buildRecallInstruction({
      responseContext: {
        currentMessage: { id: 'message-1', text: 'What remains open?' },
        conversations: [{ id: 'conv-1', summary: 'Release planning' }],
        items: [{ id: 'item-1', type: 'task', title: 'Publish release' }],
      },
    });

    assert.match(instruction, /What remains open/);
    assert.match(instruction, /Release planning/);
    assert.match(instruction, /Publish release/);
    assert.match(instruction, /Do not invent project facts/);
  });
});

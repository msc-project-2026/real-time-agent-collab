'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { loadWithMocks, makeLog } = require('./helpers.cjs');

const account = { accountId: 'default', config: { token: 'bot-token' } };
const batch = {
  ok: true,
  spaceId: 'space-1',
  batchId: 'batch-1',
  messageCount: 1,
  suggestedReplyToId: null,
  messages: [{ id: 'message-1', text: 'Fix login' }],
};

// Category: Staged-batch control flow.
// These tests verify empty stages stop immediately while non-empty stages invoke conversation processing exactly once.
describe('staged-batch control flow', () => {
  test('validates required identifiers before staging', async (t) => {
    const stagePendingBatch = t.mock.fn();
    const handleProcessStagedBatchRequest = t.mock.fn();
    const loaded = loadWithMocks(require.resolve('../batch/staging-handler'), {
      [require.resolve('../batch/stage')]: { stagePendingBatch },
      [require.resolve('../batch/processing-handler')]: {
        handleProcessStagedBatchRequest,
      },
    });
    t.after(loaded.restore);

    await assert.rejects(
      loaded.subject.handleStagePendingBatchRequest({ account }),
      /spaceId is required/
    );
    await assert.rejects(
      loaded.subject.handleStagePendingBatchRequest({ spaceId: 'space-1' }),
      /account is required/
    );
    assert.equal(stagePendingBatch.mock.callCount(), 0);
    assert.equal(handleProcessStagedBatchRequest.mock.callCount(), 0);
  });

  test('returns without processing when no batch was staged', async (t) => {
    const stagePendingBatch = t.mock.fn(async () => ({
      ok: true,
      staged: false,
      batchId: null,
      messageCount: 0,
    }));
    const handleProcessStagedBatchRequest = t.mock.fn();
    const loaded = loadWithMocks(require.resolve('../batch/staging-handler'), {
      [require.resolve('../batch/stage')]: { stagePendingBatch },
      [require.resolve('../batch/processing-handler')]: {
        handleProcessStagedBatchRequest,
      },
    });
    t.after(loaded.restore);

    const result = await loaded.subject.handleStagePendingBatchRequest({
      spaceId: 'space-1',
      account,
      log: makeLog(t),
    });

    assert.equal(result.staged, false);
    assert.equal(handleProcessStagedBatchRequest.mock.callCount(), 0);
  });

  test('does not process an inconsistent staged batch with no messages', async (t) => {
    const staged = {
      ok: true,
      staged: true,
      batchId: 'batch-empty',
      messageCount: 0,
    };
    const stagePendingBatch = t.mock.fn(async () => staged);
    const handleProcessStagedBatchRequest = t.mock.fn();
    const loaded = loadWithMocks(require.resolve('../batch/staging-handler'), {
      [require.resolve('../batch/stage')]: { stagePendingBatch },
      [require.resolve('../batch/processing-handler')]: {
        handleProcessStagedBatchRequest,
      },
    });
    t.after(loaded.restore);

    const result = await loaded.subject.handleStagePendingBatchRequest({
      spaceId: 'space-1',
      account,
    });

    assert.equal(result, staged);
    assert.equal(handleProcessStagedBatchRequest.mock.callCount(), 0);
  });

  test('processes a newly staged non-empty batch', async (t) => {
    const staged = { ok: true, staged: true, batchId: 'batch-1', messageCount: 2 };
    const stagePendingBatch = t.mock.fn(async () => staged);
    const handleProcessStagedBatchRequest = t.mock.fn(async () => undefined);
    const loaded = loadWithMocks(require.resolve('../batch/staging-handler'), {
      [require.resolve('../batch/stage')]: { stagePendingBatch },
      [require.resolve('../batch/processing-handler')]: {
        handleProcessStagedBatchRequest,
      },
    });
    t.after(loaded.restore);
    const log = makeLog(t);

    const result = await loaded.subject.handleStagePendingBatchRequest({
      spaceId: 'space-1',
      account,
      log,
    });

    assert.equal(result, staged);
    assert.deepEqual(handleProcessStagedBatchRequest.mock.calls[0].arguments[0], {
      spaceId: 'space-1',
      batchId: 'batch-1',
      account,
      log,
    });
  });
});

// Category: Conversation-processing dispatch construction.
// These tests verify staged data and active conversations become a stable internal-agent session with a recovery-key variant.
describe('conversation-processing dispatch construction', () => {
  test('loads context, builds the prompt, and dispatches the expected session payload', async (t) => {
    const existingConversations = [{ id: 'conv-1', status: 'active' }];
    const loadProcessingBatch = t.mock.fn(async () => batch);
    const getConversations = t.mock.fn(async () => existingConversations);
    const buildConversationProcessingInstruction = t.mock.fn(
      () => 'conversation prompt'
    );
    const resultHandler = t.mock.fn();
    const makeConversationProcessingResultHandler = t.mock.fn(() => resultHandler);
    let dispatched;
    const dispatchToAgent = t.mock.fn(async (options) => {
      dispatched = options;
    });
    const runtime = { channel: { reply: {} } };
    const loaded = loadWithMocks(require.resolve('../batch/processing-handler'), {
      [require.resolve('../dispatch')]: { dispatchToAgent },
      [require.resolve('../runtime')]: { getPluginRuntime: () => runtime },
      [require.resolve('../batch/load')]: { loadProcessingBatch },
      [require.resolve('../context/conversations-store')]: { getConversations },
      [require.resolve('../processing/conversations/instruction')]: {
        buildConversationProcessingInstruction,
      },
      [require.resolve('../processing/conversations/result-handler')]: {
        makeConversationProcessingResultHandler,
      },
    });
    t.after(loaded.restore);
    const log = makeLog(t);

    await loaded.subject.handleProcessStagedBatchRequest({
      spaceId: 'space-1',
      batchId: 'batch-1',
      account,
      log,
    });

    assert.deepEqual(loadProcessingBatch.mock.calls[0].arguments[0], {
      spaceId: 'space-1',
      batchId: 'batch-1',
    });
    assert.deepEqual(getConversations.mock.calls[0].arguments[0], {
      spaceId: 'space-1',
      statuses: ['active', 'dormant'],
    });
    assert.deepEqual(buildConversationProcessingInstruction.mock.calls[0].arguments[0], {
      batch,
      conversations: existingConversations,
    });
    assert.equal(dispatched.pluginRuntime, runtime);
    assert.equal(dispatched.onAgentOutput, resultHandler);

    const canonical = dispatched.buildCtxPayload();
    const recovery = dispatched.buildCtxPayload('recovery-1');
    assert.equal(canonical.CommandBody, 'conversation prompt');
    assert.equal(canonical.SessionKey, 'agent:main:webex:space-1:conv-processing');
    assert.equal(
      recovery.SessionKey,
      'agent:main:webex:space-1:conv-processing:recovery-1'
    );
    assert.equal(canonical.MessageThreadId, null);
  });

  test('validates required orchestration identifiers before reading storage', async (t) => {
    const loaded = loadWithMocks(require.resolve('../batch/processing-handler'), {
      [require.resolve('../dispatch')]: { dispatchToAgent: t.mock.fn() },
      [require.resolve('../runtime')]: { getPluginRuntime: t.mock.fn() },
      [require.resolve('../batch/load')]: { loadProcessingBatch: t.mock.fn() },
      [require.resolve('../context/conversations-store')]: { getConversations: t.mock.fn() },
      [require.resolve('../processing/conversations/instruction')]: {
        buildConversationProcessingInstruction: t.mock.fn(),
      },
      [require.resolve('../processing/conversations/result-handler')]: {
        makeConversationProcessingResultHandler: t.mock.fn(),
      },
    });
    t.after(loaded.restore);

    await assert.rejects(
      loaded.subject.handleProcessStagedBatchRequest({ batchId: 'batch-1', account }),
      /spaceId is required/
    );
    await assert.rejects(
      loaded.subject.handleProcessStagedBatchRequest({ spaceId: 'space-1', account }),
      /batchId is required/
    );
    await assert.rejects(
      loaded.subject.handleProcessStagedBatchRequest({
        spaceId: 'space-1',
        batchId: 'batch-1',
      }),
      /account is required/
    );
  });
});

// Category: Conversation model-result handling.
// These tests verify model output is parsed, validated, persisted, and passed to item extraction, with malformed and invalid output rejected.
describe('conversation model-result handling', () => {
  function loadHandler(t, overrides = {}) {
    const collaborators = {
      validateConversationProcessingResult: t.mock.fn(() => []),
      updateConversationsFromResult: t.mock.fn(async () => ({
        touchedConversationIds: ['conv-1'],
      })),
      extractItemsFromBatch: t.mock.fn(async () => ({
        skipped: false,
        candidateItemCount: 2,
      })),
      ...overrides,
    };
    const loaded = loadWithMocks(
      require.resolve('../processing/conversations/result-handler'),
      {
        [require.resolve('../processing/conversations/validate-result')]: {
          validateConversationProcessingResult:
            collaborators.validateConversationProcessingResult,
        },
        [require.resolve('../processing/conversations/update-from-result')]: {
          updateConversationsFromResult: collaborators.updateConversationsFromResult,
        },
        [require.resolve('../processing/items/extract-from-batch')]: {
          extractItemsFromBatch: collaborators.extractItemsFromBatch,
        },
        [require.resolve('../context/conversations-store')]: {
          getConversations: t.mock.fn(),
        },
      }
    );
    t.after(loaded.restore);
    return { ...loaded.subject, collaborators };
  }

  test('applies a valid result and triggers item extraction for touched conversations', async (t) => {
    const { makeConversationProcessingResultHandler, collaborators } = loadHandler(t);
    const log = makeLog(t);
    const result = {
      conversationUpdates: [
        { conversationId: 'conv-1', summary: 'Updated', messageIds: ['message-1'] },
      ],
      newConversations: [],
      untrackedMessageIds: [],
      responseDecision: { needed: false },
    };

    const response = await makeConversationProcessingResultHandler({
      processingBatch: batch,
      existingConversations: [{ id: 'conv-1' }],
      account,
      log,
    })({ text: JSON.stringify(result) });

    assert.equal(collaborators.validateConversationProcessingResult.mock.callCount(), 1);
    assert.equal(collaborators.updateConversationsFromResult.mock.callCount(), 1);
    assert.deepEqual(collaborators.extractItemsFromBatch.mock.calls[0].arguments[0], {
      processingBatch: batch,
      touchedConversationIds: ['conv-1'],
      account,
      log,
    });
    assert.equal(response.ok, true);
    assert.deepEqual(response.touchedConversationIds, ['conv-1']);
  });

  test('rejects missing result-handler orchestration context', async (t) => {
    const { makeConversationProcessingResultHandler } = loadHandler(t);
    const validText = JSON.stringify({
      conversationUpdates: [],
      newConversations: [],
      untrackedMessageIds: [],
      responseDecision: { needed: false },
    });
    await assert.rejects(
      makeConversationProcessingResultHandler({})({ text: validText }),
      /processingBatch is required/
    );
    await assert.rejects(
      makeConversationProcessingResultHandler({
        processingBatch: {},
      })({ text: validText }),
      /processingBatch\.spaceId is required/
    );
    await assert.rejects(
      makeConversationProcessingResultHandler({
        processingBatch: batch,
      })({ text: validText }),
      /account is required/
    );
  });

  test('rejects malformed JSON before validation', async (t) => {
    const { makeConversationProcessingResultHandler, collaborators } = loadHandler(t);
    const log = makeLog(t);

    await assert.rejects(
      makeConversationProcessingResultHandler({
        processingBatch: batch,
        existingConversations: [],
        account,
        log,
      })({ text: 'not json' })
    );
    assert.equal(log.warn.mock.callCount(), 1);
    assert.equal(collaborators.validateConversationProcessingResult.mock.callCount(), 0);
  });

  test('rejects validation errors before state mutation', async (t) => {
    const validateConversationProcessingResult = t.mock.fn(() => [
      'unknown conversationId: conv-x',
    ]);
    const { makeConversationProcessingResultHandler, collaborators } = loadHandler(t, {
      validateConversationProcessingResult,
    });

    await assert.rejects(
      makeConversationProcessingResultHandler({
        processingBatch: batch,
        existingConversations: [],
        account,
        log: makeLog(t),
      })({
        text: JSON.stringify({
          conversationUpdates: [],
          newConversations: [],
          untrackedMessageIds: [],
          responseDecision: { needed: false },
        }),
      }),
      /invalid processing result/
    );
    assert.equal(collaborators.updateConversationsFromResult.mock.callCount(), 0);
  });

  test('logs and propagates asynchronous persistence failures', async (t) => {
    const updateConversationsFromResult = t.mock.fn(async () => {
      throw new Error('conversation store unavailable');
    });
    const { makeConversationProcessingResultHandler } = loadHandler(t, {
      updateConversationsFromResult,
    });
    const log = makeLog(t);

    await assert.rejects(
      makeConversationProcessingResultHandler({
        processingBatch: batch,
        existingConversations: [],
        account,
        log,
      })({
        text: JSON.stringify({
          conversationUpdates: [],
          newConversations: [],
          untrackedMessageIds: [],
          responseDecision: { needed: false },
        }),
      }),
      /conversation store unavailable/
    );
    assert.ok(
      log.error.mock.calls.some((call) =>
        call.arguments[0].includes('conversation store unavailable')
      )
    );
  });
});

// Category: Item-extraction dispatch selection.
// These tests verify extraction is skipped without touched conversations and otherwise uses only touched conversations plus candidate items.
describe('item-extraction dispatch selection', () => {
  function loadExtractor(t) {
    const collaborators = {
      dispatchToAgent: t.mock.fn(async () => undefined),
      readConversationsState: t.mock.fn(async () => ({
        conversations: [
          { id: 'conv-1', summary: 'Touched' },
          { id: 'conv-2', summary: 'Untouched' },
        ],
      })),
      getCandidateItems: t.mock.fn(async () => [{ id: 'item-1' }]),
      buildItemExtractionInstruction: t.mock.fn(() => 'item prompt'),
      resultHandler: t.mock.fn(),
    };
    const loaded = loadWithMocks(
      require.resolve('../processing/items/extract-from-batch'),
      {
        [require.resolve('../dispatch')]: {
          dispatchToAgent: collaborators.dispatchToAgent,
        },
        [require.resolve('../runtime')]: { getPluginRuntime: () => ({ runtime: true }) },
        [require.resolve('../context/conversations-store')]: {
          readConversationsState: collaborators.readConversationsState,
        },
        [require.resolve('../context/items-store')]: {
          getCandidateItems: collaborators.getCandidateItems,
        },
        [require.resolve('../processing/items/instruction')]: {
          buildItemExtractionInstruction: collaborators.buildItemExtractionInstruction,
        },
        [require.resolve('../processing/items/result-handler')]: {
          makeItemExtractionResultHandler: t.mock.fn(() => collaborators.resultHandler),
        },
      }
    );
    t.after(loaded.restore);
    return { ...loaded.subject, collaborators };
  }

  test('skips all reads and dispatch when no conversation was touched', async (t) => {
    const { extractItemsFromBatch, collaborators } = loadExtractor(t);

    const response = await extractItemsFromBatch({
      processingBatch: batch,
      touchedConversationIds: [],
      account,
      log: makeLog(t),
    });

    assert.equal(response.skipped, true);
    assert.equal(collaborators.readConversationsState.mock.callCount(), 0);
    assert.equal(collaborators.dispatchToAgent.mock.callCount(), 0);
  });

  test('validates batch and account identifiers before reading context', async (t) => {
    const { extractItemsFromBatch, collaborators } = loadExtractor(t);
    const cases = [
      [{ touchedConversationIds: [], account }, /processingBatch is required/],
      [{ processingBatch: {}, touchedConversationIds: [], account }, /processingBatch\.spaceId is required/],
      [{ processingBatch: { spaceId: 'space-1' }, touchedConversationIds: [], account }, /processingBatch\.batchId is required/],
      [{ processingBatch: batch, touchedConversationIds: [] }, /account is required/],
    ];

    for (const [input, expected] of cases) {
      await assert.rejects(extractItemsFromBatch(input), expected);
    }
    assert.equal(collaborators.readConversationsState.mock.callCount(), 0);
  });

  test('builds and dispatches extraction for touched conversations and candidates', async (t) => {
    const { extractItemsFromBatch, collaborators } = loadExtractor(t);
    const log = makeLog(t);

    const response = await extractItemsFromBatch({
      processingBatch: batch,
      touchedConversationIds: ['conv-1'],
      account,
      log,
    });

    assert.deepEqual(collaborators.getCandidateItems.mock.calls[0].arguments[0], {
      spaceId: 'space-1',
      conversationIds: ['conv-1'],
      limit: 100,
    });
    assert.deepEqual(collaborators.buildItemExtractionInstruction.mock.calls[0].arguments[0], {
      processingBatch: batch,
      touchedConversations: [{ id: 'conv-1', summary: 'Touched' }],
      candidateItems: [{ id: 'item-1' }],
    });
    const dispatchOptions =
      collaborators.dispatchToAgent.mock.calls[0].arguments[0];
    assert.equal(dispatchOptions.buildCtxPayload().SessionKey,
      'agent:main:webex:space-1:item-extraction');
    assert.equal(dispatchOptions.buildCtxPayload('recovery').SessionKey,
      'agent:main:webex:space-1:item-extraction:recovery');
    assert.equal(dispatchOptions.onAgentOutput, collaborators.resultHandler);
    assert.equal(response.candidateItemCount, 1);
  });
});

// Category: Item model-result handling.
// These tests verify item output is parsed and validated before mutation and that touched item IDs are returned on success.
describe('item model-result handling', () => {
  function loadHandler(t, validationErrors = [], overrides = {}) {
    const validateItemExtractionResult = t.mock.fn(() => validationErrors);
    const updateItemsFromResult =
      overrides.updateItemsFromResult ??
      t.mock.fn(async () => ({
        touchedItemIds: ['item-1'],
      }));
    const loaded = loadWithMocks(require.resolve('../processing/items/result-handler'), {
      [require.resolve('../processing/items/validate-result')]: {
        validateItemExtractionResult,
      },
      [require.resolve('../processing/items/update-from-result')]: {
        updateItemsFromResult,
      },
    });
    t.after(loaded.restore);
    return {
      ...loaded.subject,
      validateItemExtractionResult,
      updateItemsFromResult,
    };
  }

  test('updates items for a valid extraction response', async (t) => {
    const { makeItemExtractionResultHandler, updateItemsFromResult } = loadHandler(t);
    const itemResult = { itemUpdates: [], newItems: [] };
    const log = makeLog(t);

    const response = await makeItemExtractionResultHandler({
      processingBatch: batch,
      touchedConversations: [{ id: 'conv-1' }],
      candidateItems: [{ id: 'item-1' }],
      account,
      log,
    })({ text: JSON.stringify(itemResult) });

    assert.deepEqual(updateItemsFromResult.mock.calls[0].arguments[0], {
      processingBatch: batch,
      itemExtractionResult: itemResult,
      account,
      log,
    });
    assert.deepEqual(response.touchedItemIds, ['item-1']);
  });

  test('rejects missing item-handler orchestration context', async (t) => {
    const { makeItemExtractionResultHandler } = loadHandler(t);
    const validText = '{"itemUpdates":[],"newItems":[]}';
    await assert.rejects(
      makeItemExtractionResultHandler({})({ text: validText }),
      /processingBatch is required/
    );
    await assert.rejects(
      makeItemExtractionResultHandler({ processingBatch: {} })({ text: validText }),
      /processingBatch\.spaceId is required/
    );
    await assert.rejects(
      makeItemExtractionResultHandler({ processingBatch: batch })({ text: validText }),
      /account is required/
    );
  });

  test('rejects malformed and invalid extraction output before mutation', async (t) => {
    const malformed = loadHandler(t);
    await assert.rejects(
      malformed.makeItemExtractionResultHandler({
        processingBatch: batch,
        touchedConversations: [],
        candidateItems: [],
        account,
        log: makeLog(t),
      })({ text: 'bad output' })
    );
    assert.equal(malformed.updateItemsFromResult.mock.callCount(), 0);

    const invalid = loadHandler(t, ['invalid new item type: unknown']);
    await assert.rejects(
      invalid.makeItemExtractionResultHandler({
        processingBatch: batch,
        touchedConversations: [],
        candidateItems: [],
        account,
        log: makeLog(t),
      })({ text: '{"itemUpdates":[],"newItems":[]}' }),
      /invalid item extraction result/
    );
    assert.equal(invalid.updateItemsFromResult.mock.callCount(), 0);
  });

  test('logs and propagates asynchronous item persistence failures', async (t) => {
    const updateItemsFromResult = t.mock.fn(async () => {
      throw new Error('item store unavailable');
    });
    const { makeItemExtractionResultHandler } = loadHandler(t, [], {
      updateItemsFromResult,
    });
    const log = makeLog(t);

    await assert.rejects(
      makeItemExtractionResultHandler({
        processingBatch: batch,
        touchedConversations: [],
        candidateItems: [],
        account,
        log,
      })({ text: '{"itemUpdates":[],"newItems":[]}' }),
      /item store unavailable/
    );
    assert.ok(
      log.error.mock.calls.some((call) =>
        call.arguments[0].includes('item store unavailable')
      )
    );
  });
});

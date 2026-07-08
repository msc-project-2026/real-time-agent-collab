// ********* INTERNAL-EVENTS.JS *********
'use strict';

const { buildProcessingInstruction } = require('./instructions/processing');
const { buildRoutingInstruction } = require('./instructions/routing');
const { dispatchToAgentForSpace } = require('./dispatch');
const { getPluginRuntime } = require('./runtime');

// *** Helpers
// Make handler of staging batch result
function makeStageResultHandler({ spaceId, account, log }) {
  return async ({ text }) => {
    log?.info?.(
      `[webex:${account.accountId}] inspecting agent output for staged batch`,
      {
        spaceId,
        text,
      }
    );

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      log?.warn?.(`[webex:${account.accountId}] agent output was not JSON`, {
        spaceId,
        error: err?.message ?? String(err),
        text,
      });
      return;
    }

    log?.info?.(
      `[webex:${account.accountId}] parsed agent output ${JSON.stringify({
        spaceId,
        route: parsed.route,
        hasStagedBatch: Boolean(parsed.stagedBatch),
        stagedBatch: parsed.stagedBatch ?? null,
      })}`
    );

    const isStageResult =
      parsed.route === 'stage_pending_batch' ||
      parsed.route === 'append_and_stage';

    if (!isStageResult) {
      log?.info?.(
        `[webex:${account.accountId}] agent output is not a staging result`,
        {
          spaceId,
          route: parsed.route,
        }
      );
      return;
    }

    const batchId = parsed.stagedBatch?.batchId;
    const messageCount = parsed.stagedBatch?.messageCount ?? 0;

    if (!batchId || messageCount <= 0) {
      log?.info?.(
        `[webex:${account.accountId}] staged batch result has nothing to process`,
        {
          spaceId,
          route: parsed.route,
          batchId: batchId ?? null,
          messageCount,
        }
      );
      return;
    }

    log?.info?.(
      `[webex:${account.accountId}] dispatching staged batch for processing`,
      {
        spaceId,
        batchId,
        messageCount,
        route: parsed.route,
      }
    );

    try {
      await handleProcessStagedBatchRequest({
        spaceId,
        batchId,
        account,
        log,
      });
    } catch (err) {
      log?.error?.(
        `[webex:${account.accountId}] failed to dispatch staged batch for processing`,
        {
          spaceId,
          batchId,
          error: err?.message ?? String(err),
        }
      );
      throw err;
    }
  };
}

// *** Handlers
// Stage a pending batch
async function handleStagePendingBatchRequest({ spaceId, account, log }) {
  if (!spaceId) throw new Error('spacedId is required');

  const routingInstruction = buildRoutingInstruction();

  function buildStagePendingBatchCtxPayload(sessionKeySuffix) {
    const context = {
      eventType: 'stage_pending_batch',
      internal: true,
      spaceId,
      createdAt: new Date().toISOString(),
    };

    return {
      Body: '',
      RawBody: '',
      CommandBody: [
        routingInstruction,
        '',
        'Internal collaboration event:',
        '',
        '```json',
        JSON.stringify(context, null, 2),
        '```',
        '',
        'Route this event as stage_pending_batch.',
      ].join('\n'),

      From: 'webex:internal-scheduler',
      To: `webex:${spaceId}`,

      SessionKey: sessionKeySuffix
        ? `agent:main:webex:${spaceId}:${sessionKeySuffix}`
        : `agent:main:webex:${spaceId}`,

      WebexRoomId: spaceId,
      AccountId: account.accountId,
      ChatType: 'group',
      SenderName: 'internal-scheduler',
      SenderId: 'internal-scheduler',
      Provider: 'webex',
      Surface: 'webex',
      MessageSid: `stage_pending_batch:${spaceId}:${Date.now()}`,
      Timestamp: context.createdAt,
      OriginatingChannel: 'webex',
      OriginatingTo: `webex:${spaceId}`,
      MessageThreadId: null,
    };
  }

  await dispatchToAgentForSpace({
    pluginRuntime: getPluginRuntime(),
    spaceId,
    account,
    log,
    buildCtxPayload: buildStagePendingBatchCtxPayload,
    onAgentOutput: makeStageResultHandler({
      spaceId,
      account,
      log,
    }),
  });
}

// Process staged batch
async function handleProcessStagedBatchRequest({
  spaceId,
  batchId,
  account,
  log,
}) {
  if (!spaceId) throw new Error('spaceId is required');
  if (!batchId) throw new Error('batchId is required');

  const processingInstruction = buildProcessingInstruction();

  function buildProcessStagedBatchCtxPayload(sessionKeySuffix) {
    const context = {
      eventType: 'process_staged_batch',
      internal: true,
      spaceId,
      batchId,
      createdAt: new Date().toISOString(),
    };

    return {
      Body: '',
      RawBody: '',
      CommandBody: [
        processingInstruction,
        '',
        'Internal collaboration event:',
        '',
        '```json',
        JSON.stringify(context, null, 2),
        '```',
      ].join('\n'),

      From: 'webex:internal-batch-processor',
      To: `webex:${spaceId}`,

      SessionKey: sessionKeySuffix
        ? `agent:main:webex:${spaceId}:batch:${batchId}:${sessionKeySuffix}`
        : `agent:main:webex:${spaceId}:batch:${batchId}`,

      WebexRoomId: spaceId,
      AccountId: account.accountId,
      ChatType: 'group',
      SenderName: 'internal-batch-processor',
      SenderId: 'internal-batch-processor',
      Provider: 'webex',
      Surface: 'webex',
      MessageSid: `process_staged_batch:${spaceId}:${batchId}:${Date.now()}`,
      Timestamp: context.createdAt,
      OriginatingChannel: 'webex',
      OriginatingTo: `webex:${spaceId}`,
      MessageThreadId: null,
    };
  }

  await dispatchToAgentForSpace({
    pluginRuntime: getPluginRuntime(),
    spaceId,
    account,
    log,
    buildCtxPayload: buildProcessStagedBatchCtxPayload,
  });
}

module.exports = {
  makeStageResultHandler,
  handleStagePendingBatchRequest,
  handleProcessStagedBatchRequest,
};

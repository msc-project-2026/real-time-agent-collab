// ********* INTERNAL-EVENTS.JS *********
'use strict';

const { buildProcessingInstruction } = require('./instructions/processing');
const { buildRoutingInstruction } = require('./instructions/routing');
const { dispatchToAgentForSpace } = require('./dispatch');
const { getPluginRuntime } = require('./runtime');
const { stagePendingBatch } = require('./lifecycle/stage-pending');
const { appendPendingMessage } = require('./lifecycle/append-pending');
const { schedulePendingBatchStaging } = require('./lifecycle/schedule-pending');

// *** Helpers
// Make handler for parsing message routing result
function makeRouteResultHandler({ message, account, log }) {
  const spaceId = message.roomId;

  return async ({ text }) => {
    log?.info?.(`[webex:${account.accountId}] inspecting agent route output`, {
      spaceId,
      text,
    });

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      log?.warn?.(
        `[webex:${account.accountId}] agent route output was not JSON`,
        {
          spaceId,
          error: err?.message ?? String(err),
          text,
        }
      );
      return;
    }

    log?.info?.(
      `[webex:${account.accountId}] parsed agent route output ${JSON.stringify({
        spaceId,
        route: parsed.route,
      })}`
    );

    try {
      await handleRouteResult({
        routeResult: parsed,
        message,
        account,
        log,
      });
    } catch (err) {
      log?.error?.(
        `[webex:${account.accountId}] failed to handle route result`,
        {
          spaceId,
          route: parsed.route,
          error: err?.message ?? String(err),
        }
      );
      throw err;
    }
  };
}

// *** Handlers
// Handle route result
async function handleRouteResult({ routeResult, message, account, log }) {
  const spaceId = message.roomId;
  if (!routeResult?.route) {
    log?.warn?.(`[webex:${account.accountId}] route result missing route`, {
      spaceId,
      routeResult,
    });

    return;
  }

  switch (routeResult.route) {
    case 'append_only': {
      await appendPendingMessage({ spaceId, message });

      schedulePendingBatchStaging({
        spaceId,
        account,
        log,
        batchStagingHandler: handleStagePendingBatchRequest,
      });

      return;
    }

    case 'append_and_stage': {
      await appendPendingMessage({ spaceId, message });

      await handleStagePendingBatchRequest({ spaceId, account, log });

      return;
    }

    default: {
      // unknown route
      log?.warn?.(
        `[webex:${account.accountId}] unknown or unsupported route result`,
        {
          spaceId,
          route: routeResult.route ?? null,
          routeResult,
        }
      );

      return;
    }
  }
}

// Stage a pending batch
async function handleStagePendingBatchRequest({ spaceId, account, log }) {
  if (!spaceId) throw new Error('spaceId is required');
  if (!account) throw new Error('account is required');

  const result = await stagePendingBatch(spaceId);

  log?.info?.(`[webex:${account.accountId}] pending batch staging result`, {
    spaceId,
    staged: result.staged,
    batchId: result.batchId,
    messageCount: result.messageCount,
  });

  if (!result.staged || result.messageCount <= 0) {
    return result;
  }

  await handleProcessStagedBatchRequest({
    spaceId,
    batchId: result.batchId,
    account,
    log,
  });

  return result;
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
  makeRouteResultHandler,
  handleStagePendingBatchRequest,
  handleProcessStagedBatchRequest,
};

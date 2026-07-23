// ********* ROUTING/RESULT-HANDLER.JS *********
'use strict';

const { parseJsonObjectFromText } = require('../utils/parse-json');
const { appendPendingMessage } = require('../batch/append');
const { schedulePendingBatchStaging } = require('../batch/schedule');
const { handleConfigRequest } = require('../config/handle-request');
const { handleStagePendingBatchRequest } = require('../batch/staging-handler');

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
      parsed = parseJsonObjectFromText(text);
    } catch (err) {
      log?.warn?.(
        `[webex:${account.accountId}] agent route output was not parseable ${JSON.stringify(
          {
            spaceId,
            error: err?.message ?? String(err),
            text,
          }
        )}`
      );

      // Safely append message to batch if sesion output not parseable.
      parsed = {
        route: 'append_only',
        reason: 'Fallback: route output was not parseable.',
      };

      log?.info?.(
        `[webex:${account.accountId}] falling back to append_only route ${JSON.stringify(
          {
            spaceId,
            route: parsed.route,
            reason: parsed.reason,
          }
        )}`
      );
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
        `[webex:${account.accountId}] failed to handle route result ${JSON.stringify(
          {
            spaceId,
            route: parsed.route,
            error: err?.message ?? String(err),
          }
        )}`
      );

      throw err;
    }
  };
}

// *** Handlers
// Handle route result
async function handleRouteResult({ routeResult, message, account, log }) {
  if (!message?.roomId) throw new Error('message.roomId is required');
  if (!account) throw new Error('account is required');

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

    case 'config_request': {
      await handleConfigRequest({
        spaceId,
        account,
        log,
      });

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

module.exports = { makeRouteResultHandler };

// ********* ROUTING/RESULT-HANDLER.JS *********
'use strict';

const { parseJsonObjectFromText } = require('../utils/parse-json');

const { appendPendingMessage } = require('../batch/append');
const { schedulePendingBatchStaging } = require('../batch/schedule');
const { handleStagePendingBatchRequest } = require('../batch/staging-handler');
const { handleConfigRequest } = require('../config/handle-request');
const { handleRecallRequest } = require('../recall/handle-request');

const { unique } = require('../utils/normalise');

// Helpers
function getRoutes(routeResult) {
  return Array.isArray(routeResult?.routes)
    ? routeResult.routes.map((entry) => entry?.route).filter(Boolean)
    : [];
}

function hasRoute(routes, route) {
  return routes.includes(route);
}

// Handle route result
async function handleRouteResult({ routeResult, message, account, log }) {
  if (!message?.roomId) throw new Error('message.roomId is required');
  if (!account) throw new Error('account is required');

  const spaceId = message.roomId;
  const routes = getRoutes(routeResult);

  // Validation: duplicate and unknown routes
  const uniqueRoutes = unique(routes);

  if (uniqueRoutes.length !== routes.length) {
    log?.warn?.(
      `[webex:${account.accountId}] duplicate routes in route result`,
      {
        spaceId,
        routeResult,
      }
    );
  }

  const supportedRoutes = new Set([
    'recall_request',
    'task_request',
    'config_request',
  ]);

  const unknownRoutes = uniqueRoutes.filter(
    (route) => !supportedRoutes.has(route)
  );

  if (unknownRoutes.length > 0) {
    log?.warn?.(`[webex:${account.accountId}] unknown or unsupported routes`, {
      spaceId,
      unknownRoutes,
      routeResult,
    });
  }

  // Baseline capture: all inbound messages enter the batch pipeline
  await appendPendingMessage({ spaceId, message });

  // Extra handling: config flow.
  if (hasRoute(uniqueRoutes, 'config_request')) {
    await handleConfigRequest({
      spaceId,
      account,
      log,
    });
  }

  // Extra handling: recall response.
  if (hasRoute(uniqueRoutes, 'recall_request')) {
    await handleRecallRequest({
      message,
      account,
      log,
    });
  }

  // Extra handling: task request
  // - task_request should stage immediately so the requested task is captured quickly.
  // - otherwise, use normal delayed staging.
  if (hasRoute(uniqueRoutes, 'task_request')) {
    await handleStagePendingBatchRequest({ spaceId, account, log });
    return;
  }

  // Default: delayed staging scheduled
  schedulePendingBatchStaging({
    spaceId,
    account,
    log,
    batchStagingHandler: handleStagePendingBatchRequest,
  });
}

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
            stack: err?.stack ?? null,
          }
        )}`
      );

      throw err;
    }
  };
}

module.exports = { makeRouteResultHandler };

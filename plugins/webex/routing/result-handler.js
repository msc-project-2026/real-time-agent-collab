// ********* ROUTING/RESULT-HANDLER.JS *********
'use strict';

const { appendPendingMessage } = require('../batch/append');
const { schedulePendingBatchStaging } = require('../batch/schedule');
const { handleStagePendingBatchRequest } = require('../batch/staging-handler');
const { handleConfigRequest } = require('../config/handle-request');
const { handleRecallRequest } = require('../recall/handle-request');

const { unique } = require('../utils/normalise');
const { takePendingRouteResult } = require('./tool');

// Helpers
function getRoutes(routeResult) {
  return Array.isArray(routeResult?.routes)
    ? routeResult.routes.map((entry) => entry?.route).filter(Boolean)
    : [];
}

function hasRoute(routes, route) {
  return routes.includes(route);
}

// Handle validated route result — downstream dispatch only.
// routeResult is expected to come from a validated tool call; duplicate/unknown
// route checks are still applied defensively but should not occur in the normal path.
async function handleRouteResult({
  routeResult,
  message,
  account,
  log,
  sendFn,
}) {
  if (!message?.roomId) throw new Error('message.roomId is required');
  if (!account) throw new Error('account is required');

  const spaceId = message.roomId;
  const routes = getRoutes(routeResult);

  const uniqueRoutes = unique(routes);

  if (uniqueRoutes.length !== routes.length) {
    log?.warn?.(
      `[webex:${account.accountId}] duplicate routes in route result`,
      { spaceId, routeResult }
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
    await handleConfigRequest({ spaceId, account, log, sendFn });
  }

  // Extra handling: recall response.
  if (hasRoute(uniqueRoutes, 'recall_request')) {
    await handleRecallRequest({ message, account, log, sendFn });
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

// Called after the routing dispatch completes (tool call expected during dispatch).
// Reads the pending tool result and triggers handleRouteResult.
// Falls back to append-only if the routing agent did not call route_message.
async function handleRoutingDispatchResult({
  spaceId,
  message,
  account,
  log,
  sendFn,
}) {
  const routeResult = takePendingRouteResult(spaceId);

  if (!routeResult) {
    log?.error?.(
      `[webex:${account.accountId}] routing agent did not call route_message — falling back to append-only`,
      { spaceId }
    );

    try {
      await handleRouteResult({
        routeResult: { routes: [] },
        message,
        account,
        log,
        sendFn,
      });
    } catch (err) {
      log?.error?.(
        `[webex:${account.accountId}] failed to handle fallback route result`,
        { spaceId, error: err?.message ?? String(err) }
      );
      throw err;
    }
    return;
  }

  log?.info?.(`[webex:${account.accountId}] consumed routing tool result`, {
    spaceId,
    routeCount: routeResult.routes.length,
  });

  try {
    await handleRouteResult({ routeResult, message, account, log, sendFn });
  } catch (err) {
    log?.error?.(`[webex:${account.accountId}] failed to handle route result`, {
      spaceId,
      error: err?.message ?? String(err),
      stack: err?.stack ?? null,
    });
    throw err;
  }
}

module.exports = { handleRouteResult, handleRoutingDispatchResult };

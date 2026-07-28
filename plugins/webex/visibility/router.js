// ********* VISIBILITY/ROUTER.JS *********
'use strict';

const { buildVisibilitySummary } = require('./summary');
const { getConversations } = require('../context/conversations-store');
const { getItems } = require('../context/items-store');
const { getThreads } = require('../context/threads-store');

// *** Helpers

function sendJson(res, statusCode, body) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json');
  res.end(`${JSON.stringify(body, null, 2)}\n`);
}

function getPathname(req) {
  return new URL(req.url ?? '/', 'http://x').pathname;
}

function matchSpaceRoute(pathname, suffix) {
  const match = pathname.match(
    new RegExp(`^/webex/collab/spaces/([^/]+)${suffix}$`)
  );

  return match ? decodeURIComponent(match[1]) : null;
}

// *** HTTP visibility router

// Registered at /webex/collab/ (prefix match, auth: plugin).
async function visibilityRouter(req, res) {
  const pathname = getPathname(req);

  const summarySpaceId = matchSpaceRoute(pathname, '/summary');
  const conversationsSpaceId = matchSpaceRoute(pathname, '/conversations');
  const itemsSpaceId = matchSpaceRoute(pathname, '/items');
  const threadsSpaceId = matchSpaceRoute(pathname, '/threads');

  const matchedSpaceId =
    summarySpaceId ?? conversationsSpaceId ?? itemsSpaceId ?? threadsSpaceId;

  if (!matchedSpaceId) return false;

  if (req.method !== 'GET') {
    res.statusCode = 405;
    res.setHeader('Allow', 'GET');
    res.end('Method Not Allowed');
    return true;
  }

  if (summarySpaceId) {
    const summary = await buildVisibilitySummary({
      spaceId: summarySpaceId,
    });

    sendJson(res, 200, {
      ok: true,
      summary,
    });

    return true;
  }

  if (conversationsSpaceId) {
    const conversations = await getConversations({
      spaceId: conversationsSpaceId,
      statuses: ['active', 'dormant'],
      limit: 100,
    });

    sendJson(res, 200, {
      ok: true,
      spaceId: conversationsSpaceId,
      conversations,
    });

    return true;
  }

  if (itemsSpaceId) {
    const items = await getItems({
      spaceId: itemsSpaceId,
      limit: 200,
    });

    sendJson(res, 200, {
      ok: true,
      spaceId: itemsSpaceId,
      items,
    });

    return true;
  }

  if (threadsSpaceId) {
    const threads = await getThreads({
      spaceId: threadsSpaceId,
      limit: 100,
    });

    sendJson(res, 200, {
      ok: true,
      spaceId: threadsSpaceId,
      threads,
    });

    return true;
  }

  return false;
}

module.exports = {
  visibilityRouter,
};

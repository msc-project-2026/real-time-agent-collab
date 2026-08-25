// ********* VISIBILITY/SPACE-ROUTER.JS *********
'use strict';

// Renamed from context-router.js (phase 6) — "context" named this file for
// its two data sources, context/conversations-store.js and
// context/items-store.js, both retired (v3 §7c narrows to tasks only). This
// is the general per-space visibility surface: summary, threads, tasks.

const { buildContextSummary } = require('./summary');
const { getTasks } = require('../storage/tasks-store');
const { getThreads } = require('../storage/threads-store');
const { getSpaceMembers } = require('../config/members');

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

// *** HTTP space router

// Registered at /webex/collab/ (prefix match, auth: plugin).
async function spaceRouter(req, res) {
  const pathname = getPathname(req);

  const summarySpaceId = matchSpaceRoute(pathname, '/summary');
  const tasksSpaceId = matchSpaceRoute(pathname, '/tasks');
  const threadsSpaceId = matchSpaceRoute(pathname, '/threads');
  const membersSpaceId = matchSpaceRoute(pathname, '/members');

  const matchedSpaceId = summarySpaceId ?? tasksSpaceId ?? threadsSpaceId ?? membersSpaceId;

  if (!matchedSpaceId) return false;

  if (req.method !== 'GET') {
    res.statusCode = 405;
    res.setHeader('Allow', 'GET');
    res.end('Method Not Allowed');
    return true;
  }

  if (summarySpaceId) {
    const summary = await buildContextSummary({
      spaceId: summarySpaceId,
    });

    sendJson(res, 200, {
      ok: true,
      summary,
    });

    return true;
  }

  if (tasksSpaceId) {
    const tasks = await getTasks({
      spaceId: tasksSpaceId,
      limit: 200,
    });

    sendJson(res, 200, {
      ok: true,
      spaceId: tasksSpaceId,
      tasks,
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

  if (membersSpaceId) {
    const members = await getSpaceMembers({ spaceId: membersSpaceId });

    sendJson(res, 200, {
      ok: true,
      spaceId: membersSpaceId,
      members,
    });

    return true;
  }

  return false;
}

module.exports = {
  spaceRouter,
};

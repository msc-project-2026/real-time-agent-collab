// ********* VISIBILITY/DASHBOARD-ROUTER.JS *********
'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const DASHBOARD_DIST_DIR = path.join(__dirname, '..', 'dashboard', 'dist');

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function getPathname(req) {
  return new URL(req.url ?? '/', 'http://x').pathname;
}

function sendText(res, statusCode, text) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.end(text);
}

async function sendFile(res, filePath) {
  const ext = path.extname(filePath);
  const contentType = CONTENT_TYPES[ext] ?? 'application/octet-stream';

  const body = await fs.readFile(filePath);

  res.statusCode = 200;
  res.setHeader('Content-Type', contentType);
  res.end(body);
}

// Registered at /webex/collab/dashboard/ with prefix match.
async function dashboardRouter(req, res) {
  const pathname = getPathname(req);

  if (
    pathname !== '/webex/collab/dashboard' &&
    !pathname.startsWith('/webex/collab/dashboard/')
  ) {
    return false;
  }

  if (req.method !== 'GET') {
    res.statusCode = 405;
    res.setHeader('Allow', 'GET');
    res.end('Method Not Allowed');
    return true;
  }

  const relativePath = pathname
    .replace(/^\/webex\/collab\/dashboard\/?/, '')
    .trim();

  const requestedFile = relativePath
    ? path.join(DASHBOARD_DIST_DIR, relativePath)
    : path.join(DASHBOARD_DIST_DIR, 'index.html');

  const resolvedFile = path.resolve(requestedFile);
  const resolvedDist = path.resolve(DASHBOARD_DIST_DIR);

  if (!resolvedFile.startsWith(resolvedDist)) {
    sendText(res, 403, 'Forbidden');
    return true;
  }

  try {
    await sendFile(res, resolvedFile);
    return true;
  } catch (err) {
    if (err?.code === 'ENOENT') {
      // SPA fallback.
      await sendFile(res, path.join(DASHBOARD_DIST_DIR, 'index.html'));
      return true;
    }

    throw err;
  }
}

module.exports = {
  dashboardRouter,
};

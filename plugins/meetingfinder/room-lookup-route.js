// Live test route for findActiveMeetingForRoom — the thing we haven't verified:
// does GET /meetings?roomId=...&state=active find a meeting started via the
// client's "Start meeting" button (not just API-created ad-hoc meetings)?
//
// Testing route only — nothing in the plugin's own webhook path (inbound.js)
// calls this. If it proves out, this becomes the basis for meeting-join's
// "any participant can ask to join" flow; until then it's isolated so it can't
// break anything already working.
'use strict';

const { getAccessToken } = require('./token');
const { findActiveMeetingForRoom } = require('./meeting-lookup');

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body, null, 2));
}

// Registered at /meetingfinder/lookup/ (prefix match).
// GET /meetingfinder/lookup/?roomId=<id>
async function roomLookupRoute(req, res) {
  const url = new URL(req.url ?? '/', 'http://x');
  if (!url.pathname.startsWith('/meetingfinder/lookup/')) return false;

  if (req.method !== 'GET') {
    res.statusCode = 405;
    res.setHeader('Allow', 'GET');
    res.end('Method Not Allowed');
    return true;
  }

  const roomId = url.searchParams.get('roomId');
  if (!roomId) {
    sendJson(res, 400, { error: 'missing roomId query param' });
    return true;
  }

  const token = getAccessToken() ?? process.env.WEBEX_ACCESS_TOKEN;
  if (!token) {
    sendJson(res, 500, { error: 'no access token available (plugin not started yet, or WEBEX_ACCESS_TOKEN unset)' });
    return true;
  }

  try {
    const result = await findActiveMeetingForRoom(token, roomId);
    sendJson(res, 200, { roomId, result });
  } catch (err) {
    sendJson(res, 502, { error: err?.message ?? String(err) });
  }
  return true;
}

module.exports = { roomLookupRoute };
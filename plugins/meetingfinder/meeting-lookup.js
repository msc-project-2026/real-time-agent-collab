// Resolves a pre-authenticated join link for a meeting via the dedicated
// "Join a Meeting" endpoint (no password prompt needed downstream).
'use strict';

const { webexFetch } = require('./api');

const RETRY_DELAY_MS = 4000;

// meetingId, meetingNumber, webLink are mutually exclusive in the request body —
// pass exactly one. IMPORTANT: meetingId does NOT apply to in-progress meeting
// instances (only to meeting series / scheduled meetings)
function pickIdentifier(data) {
  if (data?.meetingNumber) return { meetingNumber: data.meetingNumber };
  if (data?.webLink) return { webLink: data.webLink };
  if (data?.id) return { meetingId: data.id };
  return null;
}

async function resolveJoinLink(token, data, { retried = false } = {}) {
  const identifier = pickIdentifier(data);
  if (!identifier) throw new Error('no meetingNumber/webLink/meetingId to resolve');

  try {
    const res = await webexFetch(token, '/meetings/join', {
      method: 'POST',
      body: { ...identifier, joinDirectly: false },
    });
    if (!res?.joinLink) throw new Error('no joinLink in response');
    return res;
  } catch (err) {
    // Webhook → REST sync isn't always instant (Webex documents this as within
    // ~10 minutes for 99.5% of cases) — one retry covers the common short lag.
    if (retried) throw err;
    await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    return resolveJoinLink(token, data, { retried: true });
  }
}

module.exports = { resolveJoinLink };

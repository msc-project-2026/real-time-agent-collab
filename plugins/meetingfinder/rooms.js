'use strict';

// Dynamic replacement for a hand-maintained roomIds config list. GET /rooms
// returns every space the account is a member of — exactly the candidate set
// findRoomIdForMeeting needs — and updates itself automatically as the bot
// joins new spaces, no config edits required.
//
// Cached briefly (not re-fetched per meeting) since findRoomIdForMeeting
// already makes one API call per candidate room; re-listing rooms on top of
// that for every single meeting resolution would multiply the cost for no
// benefit — room membership doesn't change fast enough to need that.

const { webexFetch } = require('./api');

const CACHE_TTL_MS = 5 * 60 * 1000;
let cache = { ids: null, fetchedAt: 0 };

async function listRoomIds(token, { forceRefresh = false } = {}) {
  const fresh = Date.now() - cache.fetchedAt < CACHE_TTL_MS;
  if (cache.ids && fresh && !forceRefresh) return cache.ids;

  const ids = [];
  let url = '/rooms';
  // Webex paginates via a Link header, not a body field — webexFetch doesn't
  // currently expose headers, so this only fetches the first page. Fine for a
  // handful of spaces; revisit with real pagination if the account is in many.
  const res = await webexFetch(token, url);
  for (const room of res?.items ?? []) ids.push(room.id);

  cache = { ids, fetchedAt: Date.now() };
  return ids;
}

module.exports = { listRoomIds };

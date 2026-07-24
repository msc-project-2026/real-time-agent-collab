// OAuth access-token state and refresh logic for the dedicated meeting
// account. Duplicated from plugins/webex/token.js (not imported) to keep
// this plugin self-contained.
//
// Failure mode covered here (found during implementation, not in the
// original research): the existing webex plugin only refreshes this token
// proactively on a timer + at startup — a token that expires mid-window
// silently breaks every REST call until the next scheduled refresh. This
// version adds a *reactive* refresh-and-retry-once on any 401, in addition
// to the proactive timer, so a stale token self-heals on first use rather
// than waiting for the clock.
'use strict';

const { WEBEX_API, WebexApiError, webexFetch } = require('./api');

function createTokenStore(cfg, log = null) {
  let currentAccessToken = cfg.meetingAccessToken ?? null;
  let currentRefreshToken = cfg.meetingRefreshToken ?? null;
  let refreshing = null;

  async function refreshAccessToken() {
    if (!cfg.canRefreshMeetingToken) {
      throw new Error('refresh not configured (missing refreshToken/clientId/clientSecret)');
    }
    const params = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: cfg.meetingClientId,
      client_secret: cfg.meetingClientSecret,
      refresh_token: currentRefreshToken,
    });
    const res = await fetch(`${WEBEX_API}/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Webex meeting-account token refresh → ${res.status}: ${text}`);
    }
    const data = await res.json();
    // The browser meetings SDK needs the broad `spark:all` scope — granular
    // meetings:* scopes satisfy REST but Locus rejects join/leave with them.
    // The token endpoint reports the granted scopes, so surface them once per
    // refresh to make that misconfiguration visible in production logs.
    if (data.scope) {
      log?.info?.(`[webex-meeting-join] meeting-account token scopes: ${data.scope}`);
    }
    // Webex may return a renewed refresh token. Use it for later refreshes in
    // this process instead of repeatedly submitting the original value.
    if (data.refresh_token) currentRefreshToken = data.refresh_token;
    return data.access_token;
  }

  // Coalesces concurrent refresh attempts (e.g. two 401s racing) into one call.
  async function refresh() {
    if (!refreshing) {
      refreshing = refreshAccessToken()
        .then((token) => {
          currentAccessToken = token;
          return token;
        })
        .finally(() => {
          refreshing = null;
        });
    }
    return refreshing;
  }

  function getToken() {
    return currentAccessToken;
  }

  // Wraps webexFetch with the current meeting-account token; on a 401,
  // refreshes once and retries once before giving up.
  async function meetingFetch(path, opts) {
    try {
      return await webexFetch(currentAccessToken, path, opts);
    } catch (err) {
      if (err instanceof WebexApiError && err.status === 401 && cfg.canRefreshMeetingToken) {
        await refresh();
        return webexFetch(currentAccessToken, path, opts);
      }
      throw err;
    }
  }

  return { getToken, refresh, meetingFetch };
}

module.exports = { createTokenStore };

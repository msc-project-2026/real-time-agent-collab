// Webex REST API base URL and authenticated fetch helper.
// Deliberately duplicated from plugins/webex/api.js rather than imported —
// this plugin must stay self-contained so it can be copied to another
// OpenClaw instance without dragging in other plugins.
'use strict';

const WEBEX_API = 'https://webexapis.com/v1';

class WebexApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'WebexApiError';
    this.status = status;
  }
}

async function webexFetch(token, path, opts = {}) {
  const { method = 'GET', body } = opts;
  const res = await fetch(`${WEBEX_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  // 404 on DELETE is harmless — the webhook/resource is already gone.
  if (method === 'DELETE' && res.status === 404) return null;
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new WebexApiError(`Webex ${method} ${path} → ${res.status}: ${text}`, res.status);
  }
  return method === 'DELETE' ? null : res.json();
}

module.exports = { WEBEX_API, WebexApiError, webexFetch };

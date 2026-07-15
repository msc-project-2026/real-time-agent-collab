// Webex REST API base URL and authenticated fetch helper.
// This is meetingfinder's own copy — kept independent from plugins/webex so this
// plugin has no cross-plugin dependency other than the shared webhook receiver
// in plugins/webex/webhook.js.
'use strict';

const WEBEX_API = 'https://webexapis.com/v1';

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
  if (method === 'DELETE' && res.status === 404) return null;
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Webex ${method} ${path} → ${res.status}: ${text}`);
  }
  return method === 'DELETE' ? null : res.json();
}

module.exports = { WEBEX_API, webexFetch };

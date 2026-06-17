// Webex REST API base URL and authenticated fetch helper.
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
  // 404 on DELETE is harmless
  if (method === 'DELETE' && res.status === 404) return null;
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Webex ${method} ${path} → ${res.status}: ${text}`);
  }
  return method === 'DELETE' ? null : res.json();
}

module.exports = { WEBEX_API, webexFetch };

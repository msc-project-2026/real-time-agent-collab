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

function resolveWebexUrl(pathOrUrl) {
  const value = String(pathOrUrl ?? '');
  if (!/^https?:\/\//i.test(value)) return `${WEBEX_API}${value}`;
  const url = new URL(value);
  // Transcript download links currently point back to webexapis.com. Never
  // forward the meeting account's bearer token to a host supplied by a
  // webhook or API response outside that trusted origin.
  if (url.protocol !== 'https:' || url.hostname !== 'webexapis.com') {
    throw new Error(`Refusing to send Webex credentials to ${url.origin}`);
  }
  return url.toString();
}

async function webexRequest(token, pathOrUrl, opts = {}) {
  const { method = 'GET', body } = opts;
  const url = resolveWebexUrl(pathOrUrl);
  const res = await fetch(url, {
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
    throw new WebexApiError(`Webex ${method} ${pathOrUrl} → ${res.status}: ${text}`, res.status);
  }
  return res;
}

async function webexFetch(token, pathOrUrl, opts = {}) {
  const res = await webexRequest(token, pathOrUrl, opts);
  return opts.method === 'DELETE' ? null : res.json();
}

async function webexFetchText(token, pathOrUrl, opts = {}) {
  const res = await webexRequest(token, pathOrUrl, opts);
  return opts.method === 'DELETE' ? null : res.text();
}

module.exports = { WEBEX_API, WebexApiError, resolveWebexUrl, webexFetch, webexFetchText };

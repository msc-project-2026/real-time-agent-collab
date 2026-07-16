var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/webex.ts
var webex_exports = {};
__export(webex_exports, {
  MAX_WEBHOOK_BODY_BYTES: () => MAX_WEBHOOK_BODY_BYTES,
  WEBEX_API: () => WEBEX_API,
  WebexApiError: () => WebexApiError,
  delay: () => delay,
  ensureOwnedWebhooks: () => ensureOwnedWebhooks,
  readRawBody: () => readRawBody,
  verifyWebhookSignature: () => verifyWebhookSignature,
  webexList: () => webexList,
  webexRequest: () => webexRequest
});
module.exports = __toCommonJS(webex_exports);
var import_node_crypto = require("node:crypto");
var WEBEX_API = "https://webexapis.com/v1";
var MAX_WEBHOOK_BODY_BYTES = 1024 * 1024;
var WebexApiError = class extends Error {
  status;
  body;
  constructor(method, pathname, status, body) {
    super(`Webex ${method} ${pathname} failed (${status})`);
    this.name = "WebexApiError";
    this.status = status;
    this.body = body;
  }
};
async function webexRequest(token, pathname, init = {}) {
  const method = init.method ?? "GET";
  const response = await fetch(pathname.startsWith("https://") ? pathname : `${WEBEX_API}${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...init.body === void 0 ? {} : { "Content-Type": "application/json" }
    },
    ...init.body === void 0 ? {} : { body: JSON.stringify(init.body) }
  });
  const text = await response.text().catch(() => "");
  if (!response.ok) throw new WebexApiError(method, pathname, response.status, text);
  let data = {};
  if (text) data = JSON.parse(text);
  return { data, headers: response.headers };
}
async function webexList(token, pathname) {
  const items = [];
  let next = pathname;
  while (next) {
    const result = await webexRequest(token, next);
    items.push(...Array.isArray(result.data?.items) ? result.data.items : []);
    const link = result.headers?.get?.("link") ?? "";
    const match = String(link).match(/<([^>]+)>;\s*rel="next"/i);
    next = match?.[1];
    if (next && !next.startsWith(`${WEBEX_API}/`)) throw new Error("Webex pagination returned an unexpected origin");
  }
  return items;
}
async function ensureOwnedWebhooks(token, targetUrl, secret, specs) {
  const existing = await webexList(token, "/webhooks?max=100");
  for (const spec of specs) {
    const matches = existing.filter((item) => item?.name === spec.name);
    const keeper = matches.find(
      (item) => item?.targetUrl === targetUrl && item?.resource === spec.resource && item?.event === spec.event && item?.status !== "disabled"
    );
    for (const item of matches) {
      if (item === keeper) continue;
      await webexRequest(token, `/webhooks/${encodeURIComponent(item.id)}`, { method: "DELETE" });
    }
    if (!keeper) {
      await webexRequest(token, "/webhooks", {
        method: "POST",
        body: { ...spec, targetUrl, ...secret ? { secret } : {} }
      });
    }
  }
}
function verifyWebhookSignature(secret, rawBody, signature) {
  if (!secret || typeof signature !== "string" || !/^[a-f\d]{40}$/i.test(signature)) return false;
  const expected = Buffer.from((0, import_node_crypto.createHmac)("sha1", secret).update(rawBody).digest("hex"));
  const received = Buffer.from(signature.toLowerCase());
  return expected.length === received.length && (0, import_node_crypto.timingSafeEqual)(expected, received);
}
async function readRawBody(req, maxBytes = MAX_WEBHOOK_BODY_BYTES) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) {
      const error = new Error("webhook_body_too_large");
      error.code = "webhook_body_too_large";
      throw error;
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  MAX_WEBHOOK_BODY_BYTES,
  WEBEX_API,
  WebexApiError,
  delay,
  ensureOwnedWebhooks,
  readRawBody,
  verifyWebhookSignature,
  webexList,
  webexRequest
});

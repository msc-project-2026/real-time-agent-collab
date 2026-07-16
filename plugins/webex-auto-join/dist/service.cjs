var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
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
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/service.ts
var service_exports = {};
__export(service_exports, {
  BrowserControl: () => BrowserControl,
  BrowserControlError: () => BrowserControlError,
  EncryptedState: () => EncryptedState,
  MeetingJoinService: () => MeetingJoinService,
  browserActionFailure: () => browserActionFailure,
  createDiscoveredInvitation: () => createDiscoveredInvitation,
  createInvitation: () => createInvitation,
  safeErrorCode: () => safeErrorCode,
  safeErrorDetail: () => safeErrorDetail,
  safePublicFailureDetail: () => safePublicFailureDetail,
  snapshotRefs: () => snapshotRefs
});
module.exports = __toCommonJS(service_exports);
var import_node_crypto2 = require("node:crypto");
var import_promises = require("node:fs/promises");
var import_node_os = __toESM(require("node:os"), 1);
var import_node_path = __toESM(require("node:path"), 1);

// src/discovery.ts
function value(input) {
  const normalized = String(input ?? "").trim();
  return normalized && !normalized.startsWith("${") ? normalized : "";
}
function createDiscoveredInvitation(meeting, roomId) {
  const meetingId = value(meeting?.id);
  const sipAddress = value(meeting?.sipAddress);
  const webLink = value(meeting?.webLink);
  const destination = meetingId || sipAddress || webLink;
  if (!roomId || !destination) return null;
  return {
    destination,
    ...webLink ? { joinLink: webLink } : {},
    ...value(meeting?.password) ? { password: value(meeting.password) } : {},
    ...meetingId ? { meetingId } : {},
    ...value(meeting?.meetingNumber) ? { meetingNumber: value(meeting.meetingNumber) } : {},
    discoveredAt: (/* @__PURE__ */ new Date()).toISOString()
  };
}
function isJoinableMeeting(meeting) {
  return value(meeting?.meetingType) === "meeting" && ["lobby", "inProgress"].includes(value(meeting?.state));
}
function isTerminalMeeting(meeting) {
  return value(meeting?.meetingType) === "meeting" && value(meeting?.state) === "ended";
}

// src/webex.ts
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

// src/notifications.ts
var WebexMessageDelivery = class {
  constructor(botToken) {
    this.botToken = botToken;
  }
  async send(roomId, markdown) {
    const response = await fetch(`${WEBEX_API}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.botToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ roomId, markdown })
    });
    if (!response.ok) throw new Error(`Webex status send failed (${response.status})`);
  }
};

// src/service.ts
var ACTIVE_STATES = /* @__PURE__ */ new Set([
  "preparing",
  "ready_for_browser",
  "joining",
  "waiting_for_admission",
  "joined",
  "leaving",
  "interrupted",
  "recovering"
]);
function emptyState() {
  return { version: 2, sessions: {}, rooms: {}, schedules: {}, pending: {}, notifications: {} };
}
function nowIso() {
  return (/* @__PURE__ */ new Date()).toISOString();
}
function configured(value2) {
  const normalized = String(value2 ?? "").trim();
  return normalized && !normalized.startsWith("${") ? normalized : "";
}
function safeErrorCode(error) {
  const controlCode = String(error?.controlCode ?? "");
  if (controlCode === "ACT_TARGET_ID_MISMATCH") return "browser_target_id_mismatch";
  if (controlCode === "ACT_INVALID_REQUEST" || controlCode === "ACT_KIND_REQUIRED") return "browser_action_invalid";
  if (controlCode === "ACT_EXISTING_SESSION_UNSUPPORTED") return "browser_action_unsupported";
  const explicitCode = String(error?.code ?? "");
  if (explicitCode === "browser_control_unavailable" || explicitCode === "browser_control_unauthorized") return explicitCode;
  if (explicitCode === "webhook_body_too_large") return explicitCode;
  const status = Number(error?.status ?? 0);
  if (status === 401 || status === 403) return "webex_authorization_failed";
  if (status === 400) return "webex_request_invalid";
  if (status === 404) return "webex_resource_not_found";
  if (status === 409) return "webex_conflict";
  if (status === 429) return "webex_rate_limited";
  if (status >= 500) return "webex_unavailable";
  const message = String(error?.message ?? error ?? "").toLowerCase();
  if (message.includes("config is missing")) return "configuration_missing";
  if (message.includes("could not be decrypted")) return "state_decryption_failed";
  if (message.includes("encryption key")) return "encryption_key_invalid";
  if (message.includes("identities must be distinct")) return "identity_conflict";
  if (message.includes("identity does not match")) return "identity_mismatch";
  if (message.includes("captcha")) return "captcha_required";
  if (message.includes("password")) return "meeting_password_rejected";
  if (message.includes("token") || message.includes("oauth")) return "oauth_unavailable";
  if (message.includes("capacity")) return "capacity_reached";
  if (message.includes("history")) return "meeting_history_unavailable";
  return "meeting_join_failed";
}
function safePublicFailureCode(code) {
  const normalized = String(code ?? "").trim().toLowerCase();
  return /^[a-z0-9_]{1,64}$/.test(normalized) ? normalized : "meeting_join_failed";
}
function safePublicFailureDetail(detail) {
  return String(detail ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/https?:\/\/\S+/gi, "[redacted-url]").replace(/\b(access[_-]?token|refresh[_-]?token|authorization|password|secret)\b\s*[:=]\s*\S+/gi, "$1=[redacted]").replace(/(^|[^A-Za-z0-9_+/=-])[A-Za-z0-9_+/=-]{32,}(?=$|[^A-Za-z0-9_+/=-])/g, "$1[redacted-value]").replace(/[`*~<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 2e3);
}
function safeErrorDetail(error, stage) {
  const item = error ?? {};
  const controlCode = configured(item?.controlCode);
  const status = Number(item?.status ?? 0);
  const message = configured(item?.controlError) || configured(item?.message) || String(error ?? "");
  const body = typeof item?.body === "string" ? item.body : item?.body ? (() => {
    try {
      return JSON.stringify(item.body);
    } catch {
      return "";
    }
  })() : "";
  return safePublicFailureDetail([
    `stage=${stage}`,
    ...item?.name ? [`name=${item.name}`] : [],
    ...controlCode ? [`control_code=${controlCode}`] : [],
    ...status ? [`status=${status}`] : [],
    ...message ? [`message=${message}`] : [],
    ...body ? [`body=${body}`] : []
  ].join("; "));
}
function browserActionFailure(error) {
  const controlCode = String(error?.controlCode ?? "");
  const message = String(error?.controlError ?? error?.message ?? error ?? "").toLowerCase();
  if (controlCode === "ACT_TARGET_ID_MISMATCH") return { error_code: "browser_target_id_mismatch", retryable: false };
  if (controlCode === "ACT_INVALID_REQUEST" || controlCode === "ACT_KIND_REQUIRED") return { error_code: "browser_action_invalid", retryable: false };
  if (controlCode === "ACT_EXISTING_SESSION_UNSUPPORTED") return { error_code: "browser_action_unsupported", retryable: false };
  if (message.includes("unknown ref") || message.includes("stale") || message.includes("tab not found")) {
    return { error_code: "meeting_runner_snapshot_stale", retryable: true };
  }
  const code = safeErrorCode(error);
  return { error_code: code === "browser_control_unauthorized" ? code : "meeting_runner_action_failed", retryable: code !== "browser_control_unauthorized" };
}
function snapshotRefs(snapshot) {
  const refs = /* @__PURE__ */ new Set();
  if (snapshot?.refs && typeof snapshot.refs === "object") {
    for (const ref of Object.keys(snapshot.refs)) if (/^(?:\d+|e\d+|ax\d+)$/.test(ref)) refs.add(ref);
  }
  const text = String(snapshot?.snapshot ?? snapshot?.nodes ?? "");
  for (const match of text.matchAll(/(?:\[ref=|aria-ref=["'])(\d+|e\d+|ax\d+)(?:\]|["'])/g)) refs.add(match[1]);
  return [...refs];
}
function isLoopback(address) {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}
function parseCookies(raw) {
  return Object.fromEntries(String(raw ?? "").split(";").map((part) => part.trim().split("=")).filter(([key, value2]) => key && value2));
}
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}
function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}
function createInvitation(joinLink, password) {
  let parsed;
  try {
    parsed = new URL(String(joinLink ?? "").trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || !(parsed.hostname === "webex.com" || parsed.hostname.endsWith(".webex.com"))) return null;
  const normalizedPassword = String(password ?? "").trim();
  if (!normalizedPassword) return null;
  return { destination: parsed.toString(), joinLink: parsed.toString(), password: normalizedPassword, discoveredAt: nowIso() };
}
async function fileExists(filename) {
  try {
    await (0, import_promises.access)(filename);
    return true;
  } catch {
    return false;
  }
}
var EncryptedState = class {
  key;
  statePath;
  constructor(rawKey, statePath) {
    const key = rawKey ? Buffer.from(rawKey, "base64") : Buffer.alloc(0);
    if (key.length !== 32) throw new Error("encryption key must be a base64-encoded 32-byte key");
    this.key = key;
    this.statePath = statePath;
  }
  async load() {
    try {
      const envelope = JSON.parse(await (0, import_promises.readFile)(this.statePath, "utf8"));
      const decipher = (0, import_node_crypto2.createDecipheriv)("aes-256-gcm", this.key, Buffer.from(envelope.iv, "base64"));
      decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
      const plain = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, "base64")), decipher.final()]);
      const parsed = JSON.parse(plain.toString("utf8"));
      return {
        version: 2,
        sessions: parsed.sessions ?? {},
        rooms: parsed.rooms ?? {},
        schedules: parsed.schedules ?? {},
        pending: parsed.pending ?? {},
        notifications: parsed.notifications ?? {},
        token: parsed.token
      };
    } catch (error) {
      if (error?.code === "ENOENT") return emptyState();
      throw new Error("auto-join state could not be decrypted; refusing to use stored credentials");
    }
  }
  async save(state) {
    const iv = (0, import_node_crypto2.randomBytes)(12);
    const cipher = (0, import_node_crypto2.createCipheriv)("aes-256-gcm", this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(state), "utf8"), cipher.final()]);
    const envelope = JSON.stringify({
      v: 2,
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64")
    });
    await (0, import_promises.mkdir)(import_node_path.default.dirname(this.statePath), { recursive: true });
    const temp = `${this.statePath}.${process.pid}.${(0, import_node_crypto2.randomBytes)(4).toString("hex")}.tmp`;
    await (0, import_promises.writeFile)(temp, envelope, { mode: 384 });
    await (0, import_promises.rename)(temp, this.statePath);
  }
};
var BrowserControlError = class extends Error {
  code;
  status;
  controlCode;
  controlError;
  constructor(message, code, details = {}) {
    super(message);
    this.name = "BrowserControlError";
    this.code = code;
    Object.assign(this, details);
  }
};
var BrowserControl = class {
  constructor(profile) {
    this.profile = profile;
  }
  get baseUrl() {
    const port = Number(process.env.OPENCLAW_GATEWAY_PORT ?? process.env.PORT ?? 18789) + 2;
    return `http://127.0.0.1:${port}`;
  }
  async request(method, pathname, body) {
    const token = process.env.OPENCLAW_GATEWAY_TOKEN;
    if (!token) throw new BrowserControlError("OPENCLAW_GATEWAY_TOKEN is required for browser control", "browser_control_unauthorized");
    let response;
    try {
      response = await fetch(`${this.baseUrl}${pathname}${pathname.includes("?") ? "&" : "?"}profile=${encodeURIComponent(this.profile)}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...body === void 0 ? {} : { "Content-Type": "application/json" } },
        ...body === void 0 ? {} : { body: JSON.stringify(body) }
      });
    } catch (cause) {
      throw new BrowserControlError("OpenClaw browser control is unreachable", "browser_control_unavailable", { controlError: String(cause?.message ?? cause ?? "") });
    }
    if (!response.ok) {
      const responseBody = await response.json().catch(() => ({}));
      throw new BrowserControlError(`Browser control ${method} ${pathname} failed (${response.status})`, response.status === 401 || response.status === 403 ? "browser_control_unauthorized" : "browser_control_unavailable", {
        status: response.status,
        controlCode: typeof responseBody?.code === "string" ? responseBody.code : void 0,
        controlError: typeof responseBody?.error === "string" ? responseBody.error : void 0
      });
    }
    return response.json().catch(() => ({}));
  }
  start() {
    return this.request("POST", "/start?headless=true");
  }
  async open(url, label) {
    const result = await this.request("POST", "/tabs/open", { url, label });
    return result.suggestedTargetId ?? result.targetId ?? result.id;
  }
  async close(tabId) {
    if (tabId) await this.request("DELETE", `/tabs/${encodeURIComponent(tabId)}`).catch(() => void 0);
  }
  snapshot(tabId) {
    return this.request("GET", `/snapshot?targetId=${encodeURIComponent(tabId)}&format=ai`);
  }
  click(targetId, ref) {
    return this.request("POST", "/act", { kind: "click", targetId, ref });
  }
};
var MeetingJoinService = class {
  constructor(runtime, config, log = console, assets = {}) {
    this.runtime = runtime;
    this.log = log;
    this.assets = assets;
    this.cfg = {
      botToken: configured(config?.botToken) || configured(process.env.WEBEX_BOT_TOKEN),
      webhookUrl: configured(config?.webhookUrl) || configured(process.env.WEBEX_AUTO_JOIN_WEBHOOK_URL),
      webhookSecret: configured(config?.webhookSecret) || configured(process.env.WEBEX_WEBHOOK_SECRET),
      attendeeClientId: configured(config?.attendeeClientId) || configured(process.env.MEETING_JOIN_CLIENT_ID),
      attendeeClientSecret: configured(config?.attendeeClientSecret) || configured(process.env.MEETING_JOIN_CLIENT_SECRET),
      attendeeRefreshToken: configured(config?.attendeeRefreshToken) || configured(process.env.MEETING_JOIN_REFRESH_TOKEN),
      expectedAttendeeEmail: (configured(config?.expectedAttendeeEmail) || configured(process.env.MEETING_JOIN_EXPECTED_EMAIL)).toLowerCase(),
      encryptionKey: configured(config?.encryptionKey) || configured(process.env.MEETING_JOIN_ENCRYPTION_KEY),
      maxConcurrentMeetings: config?.maxConcurrentMeetings ?? 4,
      browserProfile: config?.browserProfile ?? "webex-auto-join",
      requireBrowserReview: config?.requireBrowserReview ?? false,
      recoveryMaxAttempts: config?.recoveryMaxAttempts ?? 5,
      recoveryBaseDelayMs: config?.recoveryBaseDelayMs ?? 1e3,
      meetingReconcileIntervalMs: (config?.meetingReconcileIntervalSeconds ?? 60) * 1e3,
      membershipReconcileIntervalMs: (config?.membershipReconcileIntervalSeconds ?? 300) * 1e3,
      schedulingHorizonDays: config?.schedulingHorizonDays ?? 30,
      scheduledStartGraceMinutes: config?.scheduledStartGraceMinutes ?? 30,
      notificationMode: config?.notificationMode ?? "join-and-failure"
    };
    this.browser = new BrowserControl(this.cfg.browserProfile);
    this.messages = new WebexMessageDelivery(this.cfg.botToken);
  }
  state = emptyState();
  store = null;
  runnerNonces = /* @__PURE__ */ new Map();
  runnerCookies = /* @__PURE__ */ new Map();
  queues = /* @__PURE__ */ new Map();
  scheduleTimers = /* @__PURE__ */ new Map();
  enabled = false;
  stopped = false;
  startTask = null;
  heartbeatTimer = null;
  membershipTimer = null;
  meetingTimer = null;
  startupRetryTimer = null;
  startupAttempts = 0;
  startupErrorCode;
  botId = "";
  attendeeId = "";
  cfg;
  browser;
  messages;
  async start() {
    if (this.enabled) return;
    if (this.startTask) return this.startTask;
    this.stopped = false;
    const task = this.startInternal();
    this.startTask = task;
    try {
      await task;
    } finally {
      if (this.startTask === task) this.startTask = null;
    }
  }
  async startInternal() {
    const stateDir = process.env.OPENCLAW_STATE_DIR ?? import_node_path.default.join(import_node_os.default.homedir(), ".openclaw");
    const statePath = import_node_path.default.join(stateDir, "webex-auto-join-state.enc");
    try {
      this.requireAutomationConfig();
      this.store = new EncryptedState(this.cfg.encryptionKey, statePath);
      const newStateExists = await fileExists(statePath);
      this.state = await this.store.load();
      if (!newStateExists) await this.importLegacyToken(import_node_path.default.join(stateDir, "meeting-join-state.enc"));
      const attendeeToken = await this.getAccessToken();
      const [bot, attendee] = await Promise.all([
        webexRequest(this.cfg.botToken, "/people/me").then((result) => result.data),
        webexRequest(attendeeToken, "/people/me").then((result) => result.data)
      ]);
      this.botId = configured(bot?.id);
      this.attendeeId = configured(attendee?.id);
      const attendeeEmails = [attendee?.email, ...Array.isArray(attendee?.emails) ? attendee.emails : []].map((email) => String(email ?? "").toLowerCase()).filter(Boolean);
      if (!this.botId || !this.attendeeId || this.botId === this.attendeeId) throw new Error("Webex bot and attendee identities must be distinct");
      if (!attendeeEmails.includes(this.cfg.expectedAttendeeEmail)) throw new Error("configured attendee identity does not match OAuth token");
      await this.ensureWebhooks(attendeeToken);
      this.enabled = true;
      await this.reconcileMemberships();
      await this.reconcileMeetings();
      this.rebuildScheduleTimers();
      await this.recoverActiveSessions();
      this.heartbeatTimer = setInterval(() => this.checkHeartbeats().catch(() => void 0), 15e3);
      this.membershipTimer = setInterval(() => this.reconcileMemberships().catch((error) => this.logFailure("membership reconciliation", error)), this.cfg.membershipReconcileIntervalMs);
      this.meetingTimer = setInterval(() => this.reconcileMeetings().catch((error) => this.logFailure("meeting reconciliation", error)), this.cfg.meetingReconcileIntervalMs);
      this.heartbeatTimer.unref?.();
      this.membershipTimer.unref?.();
      this.meetingTimer.unref?.();
      this.startupAttempts = 0;
      this.startupErrorCode = void 0;
      if (this.startupRetryTimer) clearTimeout(this.startupRetryTimer);
      this.startupRetryTimer = null;
      this.log?.info?.(`[webex-auto-join] ready: ${Object.values(this.state.rooms).filter((room) => room.covered).length} covered spaces`);
    } catch (error) {
      this.enabled = false;
      this.startupErrorCode = safeErrorCode(error);
      this.logFailure("startup disabled", error);
      this.scheduleStartupRetry();
    }
  }
  scheduleStartupRetry() {
    if (this.stopped || this.startupRetryTimer) return;
    const delayMs = Math.min(6e4, this.cfg.recoveryBaseDelayMs * 2 ** Math.min(this.startupAttempts, 6));
    this.startupAttempts += 1;
    this.log?.info?.(`[webex-auto-join] retrying startup in ${delayMs}ms`);
    this.startupRetryTimer = setTimeout(() => {
      this.startupRetryTimer = null;
      this.start().catch((error) => this.logFailure("startup retry", error));
    }, delayMs);
    this.startupRetryTimer.unref?.();
  }
  async stop() {
    this.stopped = true;
    this.enabled = false;
    for (const timer of [this.heartbeatTimer, this.membershipTimer, this.meetingTimer]) if (timer) clearInterval(timer);
    this.heartbeatTimer = null;
    this.membershipTimer = null;
    this.meetingTimer = null;
    if (this.startupRetryTimer) clearTimeout(this.startupRetryTimer);
    this.startupRetryTimer = null;
    for (const timer of this.scheduleTimers.values()) clearTimeout(timer);
    this.scheduleTimers.clear();
    for (const session of Object.values(this.state.sessions)) {
      if (!ACTIVE_STATES.has(session.state)) continue;
      await this.browser.close(session.tabId);
      session.tabId = void 0;
      session.state = session.state === "leaving" ? "left" : "interrupted";
      session.updatedAt = nowIso();
    }
    this.runnerNonces.clear();
    this.runnerCookies.clear();
    await this.persist().catch(() => void 0);
  }
  requireAutomationConfig() {
    for (const key of ["botToken", "webhookUrl", "webhookSecret", "attendeeClientId", "attendeeClientSecret", "attendeeRefreshToken", "expectedAttendeeEmail", "encryptionKey"]) {
      if (!this.cfg[key]) throw new Error(`webex-auto-join config is missing ${key}`);
    }
    const url = new URL(this.cfg.webhookUrl);
    if (url.protocol !== "https:" || url.pathname !== "/webhooks/webex-auto-join" || url.search || url.hash || url.username || url.password) {
      throw new Error("webhookUrl must be an HTTPS origin plus /webhooks/webex-auto-join");
    }
  }
  async importLegacyToken(legacyPath) {
    if (!await fileExists(legacyPath)) return;
    const legacy = await new EncryptedState(this.cfg.encryptionKey, legacyPath).load();
    if (legacy.token) {
      this.state.token = legacy.token;
      await this.persist();
      this.log?.info?.("[webex-auto-join] imported rotating OAuth token from legacy meeting-join state");
    }
  }
  async ensureWebhooks(attendeeToken) {
    await ensureOwnedWebhooks(this.cfg.botToken, this.cfg.webhookUrl, this.cfg.webhookSecret, [
      { name: "OpenClaw Webex Auto Join Membership Created", resource: "memberships", event: "created" },
      { name: "OpenClaw Webex Auto Join Membership Deleted", resource: "memberships", event: "deleted" }
    ]);
    await ensureOwnedWebhooks(attendeeToken, this.cfg.webhookUrl, this.cfg.webhookSecret, [
      { name: "OpenClaw Webex Auto Join Meeting Created", resource: "meetings", event: "created" },
      { name: "OpenClaw Webex Auto Join Meeting Updated", resource: "meetings", event: "updated" },
      { name: "OpenClaw Webex Auto Join Meeting Deleted", resource: "meetings", event: "deleted" },
      { name: "OpenClaw Webex Auto Join Meeting Started", resource: "meetings", event: "started" },
      { name: "OpenClaw Webex Auto Join Meeting Ended", resource: "meetings", event: "ended" }
    ]);
  }
  async handleWebhookRoute(req, res) {
    if (req.method !== "POST") {
      res.statusCode = 405;
      res.setHeader("Allow", "POST");
      res.end("Method Not Allowed");
      return true;
    }
    let raw;
    try {
      raw = await readRawBody(req);
    } catch (error) {
      res.statusCode = safeErrorCode(error) === "webhook_body_too_large" ? 413 : 400;
      res.end();
      return true;
    }
    if (!verifyWebhookSignature(this.cfg.webhookSecret, raw, req.headers?.["x-spark-signature"])) {
      res.statusCode = 401;
      res.end("Unauthorized");
      return true;
    }
    let payload;
    try {
      payload = JSON.parse(raw.toString("utf8"));
    } catch {
      res.statusCode = 400;
      res.end("Bad Request");
      return true;
    }
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end('{"ok":true}');
    const key = `${payload?.resource ?? "unknown"}:${payload?.data?.roomId ?? payload?.data?.id ?? "unknown"}`;
    this.enqueue(key, () => this.dispatchWebhook(payload));
    return true;
  }
  enqueue(key, task) {
    const previous = this.queues.get(key) ?? Promise.resolve();
    const current = previous.catch(() => void 0).then(task).catch((error) => this.logFailure(`webhook ${key}`, error)).finally(() => {
      if (this.queues.get(key) === current) this.queues.delete(key);
    });
    this.queues.set(key, current);
  }
  async dispatchWebhook(payload) {
    if (!this.enabled) return;
    if (payload?.resource === "memberships") return this.handleMembershipWebhook(payload);
    if (payload?.resource !== "meetings") return;
    const meetingId = configured(payload?.data?.id);
    if (payload?.event === "deleted") {
      await this.removeMeeting(meetingId, configured(payload?.data?.roomId));
      return;
    }
    if (payload?.data?.meetingType || payload?.data?.state) await this.processMeeting(payload.data);
    if (meetingId) {
      const meeting = await this.fetchMeetingWithRetry(meetingId);
      if (meeting) await this.processMeeting(meeting);
    }
  }
  async handleMembershipWebhook(payload) {
    const personId = configured(payload?.data?.personId);
    const roomId = configured(payload?.data?.roomId);
    if (!roomId) return;
    if (personId === this.botId) {
      if (payload.event === "deleted") await this.removeManagedRoom(roomId);
      else await this.ensureRoomCovered(roomId);
    } else if (personId === this.attendeeId && payload.event === "deleted" && this.state.rooms[roomId]) {
      await this.ensureRoomCovered(roomId);
    }
  }
  async reconcileMemberships() {
    if (!this.enabled) return;
    const rooms = await webexList(this.cfg.botToken, "/rooms?type=group&max=1000");
    const seen = /* @__PURE__ */ new Set();
    for (const room of rooms) {
      const roomId = configured(room?.id);
      if (!roomId || room?.type === "direct") continue;
      seen.add(roomId);
      await this.ensureRoomCovered(roomId, room);
    }
    for (const roomId of Object.keys(this.state.rooms)) if (!seen.has(roomId)) await this.removeManagedRoom(roomId);
  }
  async ensureRoomCovered(roomId, suppliedRoom) {
    let room = suppliedRoom;
    if (!room) {
      try {
        room = (await webexRequest(this.cfg.botToken, `/rooms/${encodeURIComponent(roomId)}`)).data;
      } catch (error) {
        this.logFailure(`room lookup ${roomId}`, error);
        return;
      }
    }
    if (room?.type === "direct") return;
    const existingState = this.state.rooms[roomId];
    try {
      const query = `/memberships?roomId=${encodeURIComponent(roomId)}&personEmail=${encodeURIComponent(this.cfg.expectedAttendeeEmail)}&max=100`;
      const memberships = await webexList(this.cfg.botToken, query);
      let membership = memberships[0];
      let provenance = existingState?.membershipProvenance === "created" ? "created" : "existing";
      if (!membership) {
        membership = (await webexRequest(this.cfg.botToken, "/memberships", {
          method: "POST",
          body: { roomId, personEmail: this.cfg.expectedAttendeeEmail, isModerator: false }
        })).data;
        provenance = "created";
      }
      this.state.rooms[roomId] = {
        roomId,
        title: configured(room?.title) || existingState?.title,
        covered: true,
        membershipId: configured(membership?.id),
        membershipProvenance: provenance,
        updatedAt: nowIso()
      };
      await this.persist();
    } catch (error) {
      const errorCode = "membership_mirror_failed";
      this.state.rooms[roomId] = {
        roomId,
        title: configured(room?.title) || existingState?.title,
        covered: false,
        membershipId: existingState?.membershipId,
        membershipProvenance: existingState?.membershipProvenance,
        lastError: errorCode,
        updatedAt: nowIso()
      };
      await this.persist();
      await this.notifyOnce(`coverage:${roomId}:${errorCode}`, roomId, `Could not add the configured meeting attendee to this space (${errorCode}). A moderator must allow or add ${this.cfg.expectedAttendeeEmail}.`).catch((notificationError) => this.logFailure(`coverage notification ${roomId}`, notificationError));
      this.logFailure(`membership mirror ${roomId}`, error);
    }
  }
  async removeManagedRoom(roomId) {
    const room = this.state.rooms[roomId];
    for (const schedule of Object.values(this.state.schedules)) if (schedule.roomId === roomId) this.deleteSchedule(schedule.id);
    for (const pending of Object.values(this.state.pending)) if (pending.roomId === roomId) delete this.state.pending[pending.meetingId];
    const active = Object.values(this.state.sessions).find((session) => session.roomId === roomId && ACTIVE_STATES.has(session.state));
    if (active) await this.leave(roomId);
    if (room?.membershipProvenance === "created" && room.membershipId) {
      const token = await this.getAccessToken().catch(() => "");
      if (token) await webexRequest(token, `/memberships/${encodeURIComponent(room.membershipId)}`, { method: "DELETE" }).catch((error) => this.logFailure(`attendee self-removal ${roomId}`, error));
    }
    delete this.state.rooms[roomId];
    await this.persist();
  }
  async reconcileMeetings() {
    if (!this.enabled) return;
    const token = await this.getAccessToken();
    const from = new Date(Date.now() - 24 * 60 * 6e4).toISOString();
    const to = new Date(Date.now() + this.cfg.schedulingHorizonDays * 24 * 60 * 6e4).toISOString();
    const series = await webexList(token, `/meetings?meetingType=meetingSeries&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&max=100`);
    for (const meeting of series) await this.processMeeting(meeting);
    const scheduled = await webexList(token, `/meetings?meetingType=scheduledMeeting&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&max=100`);
    for (const meeting of scheduled) await this.processMeeting(meeting);
    const active = await this.listMeetingInstances(token, from, to);
    for (const meeting of active) await this.processMeeting(meeting);
    await this.drainPending();
    this.pruneSchedules();
    await this.persist();
  }
  listMeetingInstances(token, from, to) {
    return webexList(token, `/meetings?meetingType=meeting&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&max=100`);
  }
  async fetchMeetingWithRetry(meetingId) {
    const started = Date.now();
    const initialDelays = [0, 1e3, 2e3, 5e3, 1e4, 2e4, 3e4];
    let attempt = 0;
    while (!this.stopped && Date.now() - started <= 10 * 6e4) {
      const wait = initialDelays[attempt] ?? 3e4;
      if (wait) await delay(wait);
      try {
        return (await webexRequest(await this.getAccessToken(), `/meetings/${encodeURIComponent(meetingId)}`)).data;
      } catch (error) {
        if (!(error instanceof WebexApiError) || ![404, 409, 429, 500, 502, 503, 504].includes(error.status)) throw error;
      }
      attempt += 1;
    }
    return null;
  }
  resolveMeetingRoomId(meeting) {
    const direct = configured(meeting?.roomId);
    if (direct) return direct;
    const scheduledId = configured(meeting?.scheduledMeetingId);
    if (scheduledId && this.state.schedules[scheduledId]) return this.state.schedules[scheduledId].roomId;
    const seriesId = configured(meeting?.meetingSeriesId);
    if (seriesId) return Object.values(this.state.schedules).find((item) => item.seriesId === seriesId)?.roomId ?? "";
    return "";
  }
  async processMeeting(meeting) {
    const meetingType = configured(meeting?.meetingType);
    const state = configured(meeting?.state);
    const meetingId = configured(meeting?.id);
    if (!meetingId) return;
    if (meetingType === "meetingSeries") {
      const seriesRoomId = this.resolveMeetingRoomId(meeting);
      const token = await this.getAccessToken();
      const from = (/* @__PURE__ */ new Date()).toISOString();
      const to = new Date(Date.now() + this.cfg.schedulingHorizonDays * 24 * 60 * 6e4).toISOString();
      const occurrences = await webexList(token, `/meetings?meetingSeriesId=${encodeURIComponent(meetingId)}&meetingType=scheduledMeeting&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&max=100`);
      for (const occurrence of occurrences) {
        await this.processMeeting(seriesRoomId && !configured(occurrence?.roomId) ? { ...occurrence, roomId: seriesRoomId } : occurrence);
      }
      return;
    }
    const roomId = this.resolveMeetingRoomId(meeting);
    if (!roomId || !this.state.rooms[roomId]?.covered) return;
    if (meetingType === "scheduledMeeting") {
      if (["ended", "missed"].includes(state)) this.deleteSchedule(meetingId);
      else this.upsertSchedule(meeting, roomId);
      await this.persist();
      return;
    }
    if (isJoinableMeeting(meeting)) await this.joinDiscoveredMeeting(meeting, roomId);
    else if (isTerminalMeeting(meeting)) await this.endMeeting(meetingId, roomId);
  }
  upsertSchedule(meeting, roomId) {
    const start = configured(meeting?.start);
    const meetingId = configured(meeting?.id);
    if (!start || !meetingId || !Number.isFinite(Date.parse(start))) return;
    const webLink = configured(meeting?.webLink);
    const sipAddress = configured(meeting?.sipAddress);
    const destination = meetingId || sipAddress || webLink;
    this.state.schedules[meetingId] = {
      id: meetingId,
      seriesId: configured(meeting?.meetingSeriesId) || void 0,
      roomId,
      title: configured(meeting?.title) || void 0,
      start,
      end: configured(meeting?.end) || void 0,
      destination,
      webLink: webLink || void 0,
      sipAddress: sipAddress || void 0,
      password: configured(meeting?.password) || void 0,
      fallbackUntil: new Date(Date.parse(start) + this.cfg.scheduledStartGraceMinutes * 6e4).toISOString(),
      updatedAt: nowIso()
    };
    this.armSchedule(meetingId);
  }
  rebuildScheduleTimers() {
    for (const meetingId of Object.keys(this.state.schedules)) this.armSchedule(meetingId);
  }
  armSchedule(meetingId, retryMs) {
    const schedule = this.state.schedules[meetingId];
    if (!schedule) return;
    const previous = this.scheduleTimers.get(meetingId);
    if (previous) clearTimeout(previous);
    const delayMs = retryMs ?? Math.max(0, Date.parse(schedule.start) - Date.now());
    if (Date.now() > Date.parse(schedule.fallbackUntil)) return;
    const maxTimeoutMs = 2147e6;
    const callback = delayMs > maxTimeoutMs ? () => this.armSchedule(meetingId) : () => this.pollScheduledMeeting(meetingId).catch((error) => this.logFailure(`scheduled poll ${meetingId}`, error));
    const timer = setTimeout(callback, Math.min(delayMs, maxTimeoutMs));
    timer.unref?.();
    this.scheduleTimers.set(meetingId, timer);
  }
  async pollScheduledMeeting(meetingId) {
    this.scheduleTimers.delete(meetingId);
    const schedule = this.state.schedules[meetingId];
    if (!schedule || Date.now() > Date.parse(schedule.fallbackUntil)) return;
    const token = await this.getAccessToken();
    const from = new Date(Date.now() - 24 * 60 * 6e4).toISOString();
    const to = new Date(Date.now() + 24 * 60 * 6e4).toISOString();
    const active = await this.listMeetingInstances(token, from, to);
    for (const meeting of active) await this.processMeeting(meeting);
    const joined = Object.values(this.state.sessions).some((session) => session.invitation.meetingId && session.roomId === schedule.roomId && ACTIVE_STATES.has(session.state));
    if (!joined) this.armSchedule(meetingId, 15e3);
  }
  deleteSchedule(meetingId) {
    const timer = this.scheduleTimers.get(meetingId);
    if (timer) clearTimeout(timer);
    this.scheduleTimers.delete(meetingId);
    delete this.state.schedules[meetingId];
  }
  pruneSchedules() {
    const cutoff = Date.now() - 60 * 6e4;
    for (const schedule of Object.values(this.state.schedules)) {
      const expiry = Date.parse(schedule.end ?? schedule.fallbackUntil);
      if (expiry < cutoff) this.deleteSchedule(schedule.id);
    }
    for (const pending of Object.values(this.state.pending)) if (Date.parse(pending.expiresAt) < Date.now()) delete this.state.pending[pending.meetingId];
  }
  async joinDiscoveredMeeting(meeting, roomId = this.resolveMeetingRoomId(meeting)) {
    if (!this.enabled) await this.start();
    if (!roomId || !this.state.rooms[roomId]?.covered) return { accepted: false, state: "failed", error_code: "space_not_covered" };
    const invitation = createDiscoveredInvitation(meeting, roomId);
    if (!invitation) return { accepted: false, state: "failed", error_code: "meeting_destination_invalid" };
    const existing = Object.values(this.state.sessions).find(
      (session) => ACTIVE_STATES.has(session.state) && (session.invitation.meetingId === invitation.meetingId || session.roomId === roomId)
    );
    if (existing?.invitation.meetingId === invitation.meetingId) return this.browserReadyResult(existing);
    const activeCount = Object.values(this.state.sessions).filter((session) => ACTIVE_STATES.has(session.state)).length;
    if (existing || activeCount >= this.cfg.maxConcurrentMeetings) {
      this.state.pending[invitation.meetingId] = {
        meetingId: invitation.meetingId,
        roomId,
        destination: invitation.destination,
        webLink: invitation.joinLink,
        password: invitation.password,
        meetingNumber: invitation.meetingNumber,
        expiresAt: configured(meeting?.end) || new Date(Date.now() + 4 * 60 * 6e4).toISOString(),
        updatedAt: nowIso()
      };
      await this.persist();
      return { accepted: false, state: "pending", error_code: existing ? "active_meeting_requires_leave" : "capacity_reached" };
    }
    delete this.state.pending[invitation.meetingId];
    return this.joinTarget(roomId, void 0, invitation, "automatic");
  }
  async drainPending() {
    for (const pending of Object.values(this.state.pending).sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))) {
      if (Date.parse(pending.expiresAt) < Date.now()) {
        delete this.state.pending[pending.meetingId];
        continue;
      }
      const result = await this.joinDiscoveredMeeting({
        id: pending.meetingId,
        roomId: pending.roomId,
        webLink: pending.webLink,
        password: pending.password,
        meetingNumber: pending.meetingNumber,
        end: pending.expiresAt
      }, pending.roomId);
      if (result.accepted) delete this.state.pending[pending.meetingId];
    }
  }
  async join(input) {
    await this.start();
    const roomId = configured(input?.room_id);
    const parentId = configured(input?.parent_id) || void 0;
    const invitation = createInvitation(input?.meeting_link, input?.meeting_password);
    if (!roomId || !invitation) return { accepted: false, state: "failed", error_code: "meeting_credentials_invalid" };
    return this.joinTarget(roomId, parentId, invitation, "manual");
  }
  async joinTarget(roomId, parentId, invitation, source) {
    if (!this.enabled) return { accepted: false, state: "failed", error_code: "meeting_join_unavailable" };
    const existing = Object.values(this.state.sessions).find((session2) => session2.roomId === roomId && ACTIVE_STATES.has(session2.state));
    if (existing) {
      if (existing.invitation.destination === invitation.destination || existing.invitation.meetingId === invitation.meetingId) return this.browserReadyResult(existing);
      return { accepted: false, state: existing.state, error_code: "active_meeting_requires_leave" };
    }
    if (Object.values(this.state.sessions).filter((session2) => ACTIVE_STATES.has(session2.state)).length >= this.cfg.maxConcurrentMeetings) {
      return { accepted: false, state: "failed", error_code: "capacity_reached" };
    }
    const session = {
      id: (0, import_node_crypto2.randomUUID)(),
      roomId,
      parentId,
      source,
      invitation,
      state: "preparing",
      recoveryAttempts: 0,
      createdAt: nowIso(),
      updatedAt: nowIso()
    };
    this.state.sessions[session.id] = session;
    await this.persist();
    try {
      if (!this.cfg.requireBrowserReview) await this.transition(session, "joining");
      await this.launch(session);
      if (this.cfg.requireBrowserReview) await this.transition(session, "ready_for_browser");
      return this.browserReadyResult(session);
    } catch (error) {
      const code = safeErrorCode(error);
      const detail = safeErrorDetail(error, "runner_launch");
      await this.fail(session, code, detail);
      return { accepted: false, session_id: session.id, state: "failed", error_code: code, error_detail: detail };
    }
  }
  browserReadyResult(session) {
    const needsBrowserAction = this.cfg.requireBrowserReview && session.state === "ready_for_browser";
    return {
      accepted: true,
      session_id: session.id,
      state: session.state,
      ...needsBrowserAction ? {
        browser_profile: this.cfg.browserProfile,
        tab_id: session.tabId,
        tab_label: session.tabLabel,
        next_action: "Call inspect_webex_meeting_runner with this session_id, choose the visible join action from its fresh snapshot, then call act_webex_meeting_runner with that ref."
      } : {}
    };
  }
  async leave(roomId) {
    const session = Object.values(this.state.sessions).find((item) => item.roomId === roomId && ACTIVE_STATES.has(item.state));
    if (!session) return { accepted: false, state: "left", error_code: "no_active_meeting" };
    session.leaveRequested = true;
    await this.transition(session, "leaving");
    const timer = setTimeout(() => {
      if (session.state === "leaving") this.completeLeave(session).catch(() => void 0);
    }, 15e3);
    timer.unref?.();
    return { accepted: true, state: "leaving" };
  }
  status(roomId) {
    const rooms = Object.values(this.state.rooms).filter((room) => !roomId || room.roomId === roomId).map((room) => ({
      room_id: room.roomId,
      title: room.title,
      covered: room.covered,
      error_code: room.lastError
    }));
    const upcoming = Object.values(this.state.schedules).filter((item) => !roomId || item.roomId === roomId).map((item) => ({
      meeting_id: item.id,
      room_id: item.roomId,
      title: item.title,
      start: item.start,
      end: item.end
    }));
    const active = Object.values(this.state.sessions).filter((item) => ACTIVE_STATES.has(item.state) && (!roomId || item.roomId === roomId)).map((item) => ({
      session_id: item.id,
      meeting_id: item.invitation.meetingId,
      room_id: item.roomId,
      state: item.state,
      source: item.source
    }));
    const failures = Object.values(this.state.sessions).filter((item) => item.state === "failed" && (!roomId || item.roomId === roomId)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 20).map((item) => ({
      session_id: item.id,
      meeting_id: item.invitation.meetingId,
      room_id: item.roomId,
      error_code: safePublicFailureCode(item.errorCode),
      error_detail: safePublicFailureDetail(item.errorDetail),
      updated_at: item.updatedAt
    }));
    return {
      enabled: this.enabled,
      startup_error_code: this.startupErrorCode,
      rooms,
      upcoming,
      active,
      failures,
      pending: Object.keys(this.state.pending).length
    };
  }
  async inspectRunner(sessionId) {
    await this.start();
    const session = this.state.sessions[configured(sessionId)];
    if (!session) return { ok: false, error_code: "meeting_session_not_found", retryable: false };
    if (!ACTIVE_STATES.has(session.state) || !session.tabId) return { ok: false, state: session.state, error_code: "meeting_runner_not_ready", retryable: false };
    try {
      const snapshot = await this.browser.snapshot(session.tabId);
      const targetId = configured(snapshot?.targetId);
      if (!targetId) throw new BrowserControlError("Meeting runner snapshot did not return a targetId", "browser_control_unavailable");
      session.inspectedTargetId = targetId;
      session.inspectedRefs = snapshotRefs(snapshot);
      return { ok: true, session_id: session.id, state: session.state, snapshot: snapshot.snapshot ?? snapshot.nodes ?? "", refs: snapshot.refs ?? {}, target_binding: "internal", truncated: Boolean(snapshot.truncated) };
    } catch (error) {
      session.inspectedTargetId = void 0;
      session.inspectedRefs = void 0;
      this.logFailure("runner inspection", error);
      return { ok: false, state: session.state, error_code: "meeting_runner_inspection_failed", retryable: true };
    }
  }
  async actOnRunner(sessionId, ref) {
    await this.start();
    const session = this.state.sessions[configured(sessionId)];
    if (!session) return { ok: false, error_code: "meeting_session_not_found", retryable: false };
    if (session.state !== "ready_for_browser" || !session.tabId) return { ok: false, state: session.state, error_code: "meeting_runner_not_ready", retryable: false };
    const normalizedRef = configured(ref);
    if (!/^(?:\d+|e\d+|ax\d+)$/.test(normalizedRef)) return { ok: false, state: session.state, error_code: "meeting_runner_ref_invalid", retryable: true };
    if (!session.inspectedTargetId || !session.inspectedRefs?.includes(normalizedRef)) return { ok: false, state: session.state, error_code: "meeting_runner_snapshot_required", retryable: true };
    const targetId = session.inspectedTargetId;
    session.inspectedTargetId = void 0;
    session.inspectedRefs = void 0;
    try {
      await this.browser.click(targetId, normalizedRef);
      return { ok: true, session_id: session.id, state: session.state, action: "click_submitted", next_action: "Inspect the meeting runner again to verify its visible status." };
    } catch (error) {
      return { ok: false, state: session.state, ...browserActionFailure(error) };
    }
  }
  async handleRunnerRoute(req, res) {
    if (!isLoopback(req.socket?.remoteAddress)) {
      res.statusCode = 403;
      res.end("Loopback only");
      return true;
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    const match = url.pathname.match(/^\/webex-auto-join\/runner\/([^/]+)(?:\/(bootstrap|events|control))?$/);
    if (!match) return false;
    const [, sessionId, action] = match;
    const session = this.state.sessions[sessionId];
    if (!session) return sendJson(res, 404, { error: "not_found" }), true;
    const cookie = parseCookies(req.headers?.cookie).webex_auto_join_session;
    const cookieSession = cookie ? this.runnerCookies.get(cookie) : null;
    const authenticated = Boolean(cookieSession && cookieSession.sessionId === sessionId && cookieSession.expiresAt > Date.now());
    if (!action) {
      if (authenticated) {
        if (url.searchParams.has("sdk")) return this.serveAsset(res, this.assets.sdk ?? process.env.MEETING_JOIN_WEBEX_SDK_PATH, "application/javascript; charset=utf-8", "webex_sdk_asset_unavailable");
        if (url.searchParams.has("asset")) return this.serveAsset(res, this.assets.runner ?? process.env.MEETING_JOIN_RUNNER_PATH, "application/javascript; charset=utf-8", "runner_asset_unavailable");
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.setHeader("Cache-Control", "no-store");
        res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>OpenClaw Webex Auto Join</title></head><body data-autostart="${this.cfg.requireBrowserReview ? "false" : "true"}"><main><h1>Webex meeting</h1><p id="meeting-status" role="status" aria-live="polite">Ready to join with the configured Webex user.</p><button id="join-meeting" type="button">Join Webex meeting</button></main><script src="${url.pathname}?sdk=1"></script><script src="${url.pathname}?asset=1"></script></body></html>`);
        return true;
      }
      const nonce = url.searchParams.get("nonce");
      const nonceSession = nonce ? this.runnerNonces.get(nonce) : null;
      if (!nonceSession || nonceSession.sessionId !== sessionId || nonceSession.expiresAt < Date.now()) return sendJson(res, 403, { error: "unauthorized" }), true;
      this.runnerNonces.delete(nonce);
      const sessionCookie = (0, import_node_crypto2.randomBytes)(24).toString("base64url");
      this.runnerCookies.set(sessionCookie, { sessionId, expiresAt: Date.now() + 60 * 6e4 });
      res.statusCode = 302;
      res.setHeader("Set-Cookie", `webex_auto_join_session=${sessionCookie}; HttpOnly; SameSite=Strict; Path=/webex-auto-join/runner/${sessionId}`);
      res.setHeader("Location", `/webex-auto-join/runner/${sessionId}`);
      res.end();
      return true;
    }
    if (!authenticated) return sendJson(res, 403, { error: "unauthorized" }), true;
    if (action === "bootstrap" && req.method === "GET") {
      try {
        return sendJson(res, 200, { accessToken: await this.getAccessToken(), destination: session.invitation.destination, joinLink: session.invitation.joinLink, password: session.invitation.password, meetingId: session.invitation.meetingId, sessionId }), true;
      } catch (error) {
        return sendJson(res, 503, { error: safeErrorCode(error) }), true;
      }
    }
    if (action === "control" && req.method === "GET") return sendJson(res, 200, { leave: Boolean(session.leaveRequested) }), true;
    if (action === "events" && req.method === "POST") {
      try {
        await this.handleRunnerEvent(session, await readJsonBody(req));
        return sendJson(res, 200, { ok: true }), true;
      } catch {
        return sendJson(res, 400, { error: "invalid_event" }), true;
      }
    }
    res.statusCode = 405;
    res.end("Method Not Allowed");
    return true;
  }
  async serveAsset(res, filename, contentType, errorCode) {
    try {
      if (!filename) throw new Error("asset path missing");
      res.statusCode = 200;
      res.setHeader("Content-Type", contentType);
      res.setHeader("Cache-Control", "no-store");
      res.end(await (0, import_promises.readFile)(filename));
    } catch {
      sendJson(res, 500, { error: errorCode });
    }
    return true;
  }
  async handleRunnerEvent(session, event) {
    const type = configured(event?.type);
    if (type === "joining") await this.transition(session, "joining");
    else if (type === "waiting_for_admission") await this.transition(session, "waiting_for_admission");
    else if (type === "joined") {
      session.recoveryAttempts = 0;
      await this.transition(session, "joined");
    } else if (type === "left") await this.completeLeave(session);
    else if (type === "ended") await this.completeEnd(session);
    else if (type === "error") {
      const code = configured(event?.code) || "meeting_join_failed";
      const detail = safePublicFailureDetail(event?.detail);
      if (session.recoveryAttempts > 0 && session.recoveryAttempts < this.cfg.recoveryMaxAttempts) {
        await this.transition(session, "interrupted");
        this.recover(session).catch(() => this.fail(session, code, detail));
      } else await this.fail(session, code, detail);
    } else if (type === "heartbeat") {
      session.updatedAt = nowIso();
      await this.persist();
    }
  }
  async launch(session) {
    await this.getAccessToken();
    await this.browser.start();
    const nonce = (0, import_node_crypto2.randomBytes)(24).toString("base64url");
    this.runnerNonces.set(nonce, { sessionId: session.id, expiresAt: Date.now() + 6e4 });
    const port = Number(process.env.OPENCLAW_GATEWAY_PORT ?? process.env.PORT ?? 18789);
    const runnerUrl = `http://127.0.0.1:${port}/webex-auto-join/runner/${session.id}?nonce=${encodeURIComponent(nonce)}`;
    session.tabLabel = `meeting:${Buffer.from(session.roomId).toString("base64url").slice(0, 20)}`;
    session.inspectedTargetId = void 0;
    session.inspectedRefs = void 0;
    session.tabId = await this.browser.open(runnerUrl, session.tabLabel);
    if (!session.tabId) throw new Error("Browser did not return a meeting tab identifier");
    session.updatedAt = nowIso();
    await this.persist();
  }
  async recoverActiveSessions() {
    for (const session of Object.values(this.state.sessions)) {
      if (!ACTIVE_STATES.has(session.state) || session.state === "leaving") continue;
      this.recover(session).catch((error) => this.logFailure("session recovery", error));
    }
  }
  async checkHeartbeats() {
    const cutoff = Date.now() - 45e3;
    for (const session of Object.values(this.state.sessions)) {
      if (!["joining", "waiting_for_admission", "joined"].includes(session.state) || Date.parse(session.updatedAt) >= cutoff) continue;
      await this.transition(session, "interrupted");
      this.recover(session).catch(() => this.fail(session, "runner_heartbeat_lost", "stage=runner_heartbeat; message=Meeting runner stopped reporting heartbeats"));
    }
  }
  async recover(session) {
    let lastErrorDetail = "";
    while (session.recoveryAttempts < this.cfg.recoveryMaxAttempts && ACTIVE_STATES.has(session.state)) {
      session.recoveryAttempts += 1;
      await this.transition(session, "recovering");
      try {
        await this.browser.close(session.tabId);
        if (!this.cfg.requireBrowserReview) await this.transition(session, "joining");
        await this.launch(session);
        if (this.cfg.requireBrowserReview) await this.transition(session, "ready_for_browser");
        return;
      } catch (error) {
        lastErrorDetail = safeErrorDetail(error, "runner_recovery");
        await delay(this.cfg.recoveryBaseDelayMs * 2 ** (session.recoveryAttempts - 1) + Math.floor(Math.random() * 250));
      }
    }
    await this.fail(session, "recovery_exhausted", lastErrorDetail || "stage=runner_recovery; message=Recovery attempts were exhausted");
  }
  async endMeeting(meetingId, roomId) {
    delete this.state.pending[meetingId];
    this.deleteSchedule(configured(Object.values(this.state.schedules).find((schedule) => schedule.roomId === roomId && (schedule.id === meetingId || schedule.seriesId === meetingId))?.id));
    const session = Object.values(this.state.sessions).find((item) => item.invitation.meetingId === meetingId || item.roomId === roomId);
    if (session && ACTIVE_STATES.has(session.state)) await this.completeEnd(session);
    await this.persist();
  }
  async removeMeeting(meetingId, roomId) {
    if (meetingId) this.deleteSchedule(meetingId);
    if (meetingId) delete this.state.pending[meetingId];
    const session = Object.values(this.state.sessions).find((item) => item.invitation.meetingId === meetingId);
    if (roomId || session) await this.endMeeting(meetingId, roomId || session?.roomId || "");
    await this.persist();
  }
  async completeLeave(session) {
    await this.browser.close(session.tabId);
    this.invalidateRunnerAuth(session.id);
    session.tabId = void 0;
    await this.transition(session, "left");
    await this.drainPending();
  }
  async completeEnd(session) {
    await this.browser.close(session.tabId);
    this.invalidateRunnerAuth(session.id);
    session.tabId = void 0;
    await this.transition(session, "ended");
    await this.drainPending();
  }
  async fail(session, code, detail) {
    await this.browser.close(session.tabId);
    this.invalidateRunnerAuth(session.id);
    session.tabId = void 0;
    await this.transition(session, "failed", safePublicFailureCode(code), safePublicFailureDetail(detail));
    await this.drainPending();
  }
  async transition(session, next, errorCode, errorDetail) {
    session.state = next;
    session.updatedAt = nowIso();
    if (next === "failed") {
      session.errorCode = safePublicFailureCode(errorCode);
      session.errorDetail = safePublicFailureDetail(errorDetail) || void 0;
    } else if (!["interrupted", "recovering"].includes(next)) {
      session.errorCode = void 0;
      session.errorDetail = void 0;
    }
    if (["left", "ended", "failed"].includes(next)) session.leaveRequested = false;
    await this.persist();
    if (next === "joined" && this.cfg.notificationMode === "join-and-failure") {
      const message = session.source === "automatic" ? "Joined the Webex meeting automatically." : "Joined the Webex meeting.";
      await this.notifyOnce(`joined:${session.invitation.meetingId ?? session.id}`, session.roomId, message).catch((error) => this.logFailure("joined notification", error));
    } else if (next === "failed") {
      const code = session.errorCode ?? "meeting_join_failed";
      const detail = session.errorDetail || "No additional diagnostic was supplied by the Webex SDK.";
      this.log?.warn?.(`[webex-auto-join] session ${session.id} failed: ${code}; ${detail}`);
      const notification = [
        "Could not join or continue the Webex meeting.",
        `Error code: ${code}`,
        `Diagnostic: ${detail}`,
        `Session: ${session.id}`
      ].join("\n\n");
      await this.notifyOnce(`failed-v2:${session.invitation.meetingId ?? session.id}`, session.roomId, notification).catch((error) => this.logFailure("failure notification", error));
    }
  }
  async notifyOnce(key, roomId, markdown) {
    if (this.state.notifications[key]) return;
    await this.messages.send(roomId, markdown);
    this.state.notifications[key] = nowIso();
    await this.persist();
  }
  invalidateRunnerAuth(sessionId) {
    for (const [nonce, value2] of this.runnerNonces) if (value2.sessionId === sessionId) this.runnerNonces.delete(nonce);
    for (const [cookie, value2] of this.runnerCookies) if (value2.sessionId === sessionId) this.runnerCookies.delete(cookie);
  }
  async getAccessToken() {
    if (!this.store) throw new Error("auto-join state unavailable");
    const cached = this.state.token;
    if (cached && cached.expiresAt > Date.now() + 12e4) return cached.accessToken;
    const refreshToken = cached?.refreshToken ?? this.cfg.attendeeRefreshToken;
    if (!refreshToken || !this.cfg.attendeeClientId || !this.cfg.attendeeClientSecret) throw new Error("meeting OAuth credentials are unavailable");
    const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: this.cfg.attendeeClientId, client_secret: this.cfg.attendeeClientSecret });
    const response = await fetch(`${WEBEX_API}/access_token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
    if (!response.ok) throw new Error(`OAuth refresh failed (${response.status})`);
    const token = await response.json();
    if (!token.access_token) throw new Error("OAuth refresh response incomplete");
    this.state.token = { accessToken: token.access_token, refreshToken: token.refresh_token ?? refreshToken, expiresAt: Date.now() + Number(token.expires_in ?? 0) * 1e3 };
    await this.persist();
    return token.access_token;
  }
  async persist() {
    if (this.store) await this.store.save(this.state);
  }
  logFailure(context, error) {
    const detail = safeErrorDetail(error, context);
    this.log?.warn?.(`[webex-auto-join] ${context}: ${safeErrorCode(error)}; ${detail}`);
  }
};
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  BrowserControl,
  BrowserControlError,
  EncryptedState,
  MeetingJoinService,
  browserActionFailure,
  createDiscoveredInvitation,
  createInvitation,
  safeErrorCode,
  safeErrorDetail,
  safePublicFailureDetail,
  snapshotRefs
});

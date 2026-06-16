"use strict";
/**
 * OpenClaw Channel Plugin for Webex
 *
 * Implements the ChannelPlugin interface for OpenClaw's plugin system.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.webexPlugin = void 0;
exports.setPluginRuntime = setPluginRuntime;
exports.registerWebexWebhookTarget = registerWebexWebhookTarget;
exports.createWebhookHandler = createWebhookHandler;
const send_1 = require("./send");
const webhook_1 = require("./webhook");
// Store the plugin runtime for use in HTTP handlers
let pluginRuntime = null;
function setPluginRuntime(runtime) {
    pluginRuntime = runtime;
}
const DEFAULT_ACCOUNT_ID = "default";
const webhookTargets = new Map();
function normalizeWebhookPath(raw) {
    const trimmed = raw.trim();
    if (!trimmed)
        return "/";
    const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
    if (withSlash.length > 1 && withSlash.endsWith("/")) {
        return withSlash.slice(0, -1);
    }
    return withSlash;
}
function registerWebexWebhookTarget(path, target) {
    const key = normalizeWebhookPath(path);
    webhookTargets.set(key, target);
    return () => {
        webhookTargets.delete(key);
    };
}
async function readJsonBody(req, maxBytes) {
    const chunks = [];
    let total = 0;
    return await new Promise((resolve) => {
        req.on("data", (chunk) => {
            total += chunk.length;
            if (total > maxBytes) {
                resolve({ ok: false, error: "payload too large" });
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on("end", () => {
            try {
                const body = Buffer.concat(chunks).toString("utf-8");
                const parsed = JSON.parse(body);
                resolve({ ok: true, value: parsed });
            }
            catch {
                resolve({ ok: false, error: "invalid json" });
            }
        });
        req.on("error", (err) => {
            resolve({ ok: false, error: err.message });
        });
    });
}
/**
 * Create the webhook handler with access to the plugin runtime.
 * Returns a handler function that can process incoming Webex webhook requests.
 */
function createWebhookHandler() {
    return async (req, res) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        const path = normalizeWebhookPath(url.pathname);
        // Check if path matches /webhooks/webex/*
        if (!path.startsWith("/webhooks/webex/")) {
            return false;
        }
        const target = webhookTargets.get(path);
        if (!target) {
            return false;
        }
        if (req.method !== "POST") {
            res.statusCode = 405;
            res.setHeader("Allow", "POST");
            res.end("Method Not Allowed");
            return true;
        }
        const body = await readJsonBody(req, 1024 * 1024);
        if (!body.ok) {
            res.statusCode = body.error === "payload too large" ? 413 : 400;
            res.end(body.error ?? "invalid payload");
            return true;
        }
        const { account, webhookHandler } = target;
        try {
            const signature = req.headers["x-spark-signature"];
            const payload = body.value;
            const envelope = await webhookHandler.handleWebhook(payload, signature);
            if (envelope && pluginRuntime) {
                // Load config using the plugin runtime (cast to any for internal API access)
                const runtime = pluginRuntime;
                const cfg = runtime.config?.loadConfig?.() ?? {};
                // Build the context payload for OpenClaw's message pipeline
                const ctxPayload = {
                    Body: envelope.content.text ?? "",
                    RawBody: envelope.content.text ?? "",
                    CommandBody: envelope.content.text ?? "",
                    From: `webex:${envelope.author.id}`,
                    To: `webex:${envelope.conversationId}`,
                    SessionKey: `agent:main:webex:${envelope.conversationId}`,
                    AccountId: account.accountId,
                    ChatType: envelope.metadata.roomType === "direct" ? "direct" : "group",
                    SenderName: envelope.author.displayName ?? envelope.author.email ?? envelope.author.id,
                    SenderId: envelope.author.id,
                    Provider: "webex",
                    Surface: "webex",
                    MessageSid: envelope.id,
                    Timestamp: envelope.metadata.timestamp,
                    OriginatingChannel: "webex",
                    OriginatingTo: `webex:${envelope.conversationId}`,
                    MessageThreadId: envelope.metadata.parentId,
                };
                // Use the plugin runtime's dispatch function (cast to any for internal API)
                const dispatchReply = runtime.channel?.reply?.dispatchReplyWithBufferedBlockDispatcher;
                if (dispatchReply) {
                    // Create a sender for replies
                    const sender = new send_1.WebexSender(account.config);
                    await dispatchReply({
                        ctx: ctxPayload,
                        cfg,
                        dispatcherOptions: {
                            deliver: async (payload) => {
                                if (payload.text) {
                                    await sender.send({
                                        to: envelope.conversationId,
                                        content: { text: payload.text },
                                        parentId: envelope.metadata.parentId,
                                    });
                                }
                            },
                            onError: (err) => {
                                console.error(`[webex:${account.accountId}] reply dispatch error: ${err.message}`);
                            },
                        },
                        replyOptions: {},
                    });
                }
                else {
                    console.warn(`[webex:${account.accountId}] dispatchReply not available in plugin runtime`);
                }
            }
            res.statusCode = 200;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ ok: true }));
            return true;
        }
        catch (err) {
            console.error(`[webex:${account.accountId}] webhook error: ${err instanceof Error ? err.message : err}`);
            res.statusCode = 500;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: "Internal error" }));
            return true;
        }
    };
}
function listWebexAccountIds(cfg) {
    const section = cfg.channels?.webex;
    if (!section)
        return [];
    const ids = [];
    // Check for top-level config (default account)
    if (section.token) {
        ids.push(DEFAULT_ACCOUNT_ID);
    }
    // Check for named accounts
    if (section.accounts) {
        for (const id of Object.keys(section.accounts)) {
            if (id !== DEFAULT_ACCOUNT_ID) {
                ids.push(id);
            }
        }
    }
    return ids;
}
function resolveWebexAccount(opts) {
    const { cfg, accountId = DEFAULT_ACCOUNT_ID } = opts;
    const section = cfg.channels?.webex;
    if (!section) {
        return {
            accountId,
            enabled: false,
            configured: false,
            config: {},
        };
    }
    // Check for named account first
    const namedAccount = section.accounts?.[accountId];
    if (namedAccount) {
        const token = namedAccount.token ?? section.token;
        const webhookUrl = namedAccount.webhookUrl ?? section.webhookUrl;
        return {
            accountId,
            name: namedAccount.name,
            enabled: namedAccount.enabled !== false,
            configured: Boolean(token && webhookUrl),
            token,
            webhookUrl,
            config: {
                token: token ?? "",
                webhookUrl: webhookUrl ?? "",
                webhookSecret: namedAccount.webhookSecret ?? section.webhookSecret,
                dmPolicy: namedAccount.dmPolicy ?? section.dmPolicy ?? "allow",
                allowFrom: namedAccount.allowFrom ?? section.allowFrom,
                apiBaseUrl: namedAccount.apiBaseUrl ?? section.apiBaseUrl,
                maxRetries: namedAccount.maxRetries ?? section.maxRetries,
                retryDelayMs: namedAccount.retryDelayMs ?? section.retryDelayMs,
            },
        };
    }
    // Fall back to top-level config (default account)
    if (accountId === DEFAULT_ACCOUNT_ID) {
        return {
            accountId,
            name: section.name,
            enabled: section.enabled !== false,
            configured: Boolean(section.token && section.webhookUrl),
            token: section.token,
            webhookUrl: section.webhookUrl,
            config: {
                token: section.token ?? "",
                webhookUrl: section.webhookUrl ?? "",
                webhookSecret: section.webhookSecret,
                dmPolicy: section.dmPolicy ?? "allow",
                allowFrom: section.allowFrom,
                apiBaseUrl: section.apiBaseUrl,
                maxRetries: section.maxRetries,
                retryDelayMs: section.retryDelayMs,
            },
        };
    }
    // Account not found
    return {
        accountId,
        enabled: false,
        configured: false,
        config: {},
    };
}
const meta = {
    id: "webex",
    label: "Webex",
    selectionLabel: "Cisco Webex",
    docsPath: "/channels/webex",
    docsLabel: "webex",
    blurb: "Cisco Webex messaging via bot webhooks.",
    order: 75,
    aliases: ["cisco-webex"],
};
exports.webexPlugin = {
    id: "webex",
    meta,
    capabilities: {
        chatTypes: ["direct", "group"],
        threads: true,
        media: true,
    },
    reload: { configPrefixes: ["channels.webex"] },
    config: {
        listAccountIds: (cfg) => listWebexAccountIds(cfg),
        resolveAccount: (cfg, accountId) => resolveWebexAccount({ cfg: cfg, accountId }),
        defaultAccountId: () => DEFAULT_ACCOUNT_ID,
        setAccountEnabled: ({ cfg, accountId, enabled }) => {
            const config = cfg;
            const section = config.channels?.webex ?? {};
            if (accountId === DEFAULT_ACCOUNT_ID) {
                return {
                    ...config,
                    channels: {
                        ...config.channels,
                        webex: {
                            ...section,
                            enabled,
                        },
                    },
                };
            }
            return {
                ...config,
                channels: {
                    ...config.channels,
                    webex: {
                        ...section,
                        accounts: {
                            ...section.accounts,
                            [accountId]: {
                                ...section.accounts?.[accountId],
                                enabled,
                            },
                        },
                    },
                },
            };
        },
        deleteAccount: ({ cfg, accountId }) => {
            const config = cfg;
            const section = config.channels?.webex ?? {};
            if (accountId === DEFAULT_ACCOUNT_ID) {
                const { token, webhookUrl, webhookSecret, dmPolicy, allowFrom, ...rest } = section;
                return {
                    ...config,
                    channels: {
                        ...config.channels,
                        webex: rest,
                    },
                };
            }
            const accounts = { ...section.accounts };
            delete accounts[accountId];
            return {
                ...config,
                channels: {
                    ...config.channels,
                    webex: {
                        ...section,
                        accounts,
                    },
                },
            };
        },
        isConfigured: (account) => account.configured,
        describeAccount: (account) => ({
            accountId: account.accountId,
            name: account.name,
            enabled: account.enabled,
            configured: account.configured,
            baseUrl: account.config.apiBaseUrl ?? "https://webexapis.com/v1",
        }),
        resolveAllowFrom: ({ cfg }) => (cfg.channels?.webex?.allowFrom ?? []).map(String),
        formatAllowFrom: ({ allowFrom }) => allowFrom.map((entry) => entry.trim().toLowerCase()),
    },
    security: {
        resolveDmPolicy: ({ account }) => {
            const policy = account.config.dmPolicy ?? "allow";
            // Map "allowlisted" to "allowlist" for OpenClaw compatibility
            const normalizedPolicy = policy === "allowlisted" ? "allowlist" : policy;
            return {
                policy: normalizedPolicy,
                allowFrom: account.config.allowFrom ?? [],
                policyPath: "channels.webex.dmPolicy",
                allowFromPath: "channels.webex.allowFrom",
                approveHint: "Add user ID or email to channels.webex.allowFrom",
                normalizeEntry: (raw) => raw.trim().toLowerCase(),
            };
        },
    },
    threading: {
        resolveReplyToMode: () => "off",
        buildToolContext: ({ context, hasRepliedRef }) => ({
            currentChannelId: context.To?.trim() || undefined,
            currentThreadTs: context.MessageThreadId != null
                ? String(context.MessageThreadId)
                : context.ReplyToId,
            hasRepliedRef,
        }),
    },
    messaging: {
        normalizeTarget: (raw) => {
            let normalized = raw.trim();
            if (!normalized)
                return undefined;
            if (normalized.toLowerCase().startsWith("webex:")) {
                normalized = normalized.slice("webex:".length).trim();
            }
            return normalized || undefined;
        },
        targetResolver: {
            looksLikeId: (raw) => {
                const trimmed = raw.trim();
                if (!trimmed)
                    return false;
                // Webex IDs are base64-encoded and start with a specific prefix
                if (trimmed.startsWith("Y2lzY29zcGFyazovL3"))
                    return true;
                // Also accept emails
                return trimmed.includes("@");
            },
            hint: "<roomId|personId|email>",
        },
    },
    outbound: {
        deliveryMode: "direct",
        textChunkLimit: 7000, // Webex has a 7439 byte limit
        sendText: async ({ to, text, account, replyToId }) => {
            const sender = new send_1.WebexSender(account.config);
            const result = await sender.send({
                to,
                content: { text },
                parentId: replyToId,
            });
            return {
                channel: "webex",
                messageId: result.id,
                roomId: result.roomId,
            };
        },
        sendMedia: async ({ to, text, mediaUrl, account, replyToId }) => {
            const sender = new send_1.WebexSender(account.config);
            const result = await sender.send({
                to,
                content: {
                    text,
                    files: mediaUrl ? [mediaUrl] : undefined,
                },
                parentId: replyToId,
            });
            return {
                channel: "webex",
                messageId: result.id,
                roomId: result.roomId,
            };
        },
    },
    status: {
        defaultRuntime: {
            accountId: DEFAULT_ACCOUNT_ID,
            running: false,
            lastStartAt: null,
            lastStopAt: null,
            lastError: null,
        },
        collectStatusIssues: (accounts) => accounts.flatMap((account) => {
            const lastError = typeof account.lastError === "string" ? account.lastError.trim() : "";
            if (!lastError)
                return [];
            return [
                {
                    channel: "webex",
                    accountId: account.accountId,
                    kind: "runtime",
                    message: `Channel error: ${lastError}`,
                },
            ];
        }),
        buildChannelSummary: ({ snapshot }) => ({
            configured: (snapshot.configured ?? false),
            baseUrl: (snapshot.baseUrl ?? null),
            running: (snapshot.running ?? false),
            lastStartAt: (snapshot.lastStartAt ?? null),
            lastStopAt: (snapshot.lastStopAt ?? null),
            lastError: (snapshot.lastError ?? null),
        }),
        probeAccount: async ({ account, timeoutMs }) => {
            if (!account.configured) {
                return {
                    ok: false,
                    error: "Account not configured",
                    elapsedMs: 0,
                };
            }
            const start = Date.now();
            try {
                const response = await fetch(`${account.config.apiBaseUrl ?? "https://webexapis.com/v1"}/people/me`, {
                    method: "GET",
                    headers: {
                        Authorization: `Bearer ${account.config.token}`,
                        "Content-Type": "application/json",
                    },
                    signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined,
                });
                const elapsedMs = Date.now() - start;
                if (!response.ok) {
                    return {
                        ok: false,
                        error: `HTTP ${response.status}: ${response.statusText}`,
                        elapsedMs,
                    };
                }
                return { ok: true, elapsedMs };
            }
            catch (err) {
                return {
                    ok: false,
                    error: err instanceof Error ? err.message : String(err),
                    elapsedMs: Date.now() - start,
                };
            }
        },
        buildAccountSnapshot: ({ account, runtime, probe }) => ({
            accountId: account.accountId,
            name: account.name,
            enabled: account.enabled,
            configured: account.configured,
            baseUrl: account.config.apiBaseUrl ?? "https://webexapis.com/v1",
            running: runtime?.running ?? false,
            lastStartAt: runtime?.lastStartAt ?? null,
            lastStopAt: runtime?.lastStopAt ?? null,
            lastError: runtime?.lastError ?? null,
            probe,
            lastProbeAt: runtime?.lastProbeAt ?? null,
        }),
    },
    gateway: {
        startAccount: async (ctx) => {
            const { account, runtime, log, setStatus } = ctx;
            setStatus({
                accountId: account.accountId,
                baseUrl: account.config.apiBaseUrl ?? "https://webexapis.com/v1",
            });
            log?.info?.(`[${account.accountId}] starting Webex provider (webhook mode)`);
            // Initialize webhook handler
            const webhookHandler = new webhook_1.WebexWebhookHandler(account.config);
            await webhookHandler.initialize();
            // Register webhooks with Webex
            try {
                await webhookHandler.registerWebhooks();
                log?.info?.(`[${account.accountId}] webhooks registered`);
            }
            catch (err) {
                log?.warn?.(`[${account.accountId}] failed to register webhooks: ${err instanceof Error ? err.message : err}`);
            }
            // Register webhook target for HTTP handler
            const webhookPath = `/webhooks/webex/${account.accountId}`;
            const unregister = registerWebexWebhookTarget(webhookPath, {
                account,
                config: account.config,
                webhookHandler,
            });
            log?.info?.(`[${account.accountId}] HTTP webhook handler registered at ${webhookPath}`);
            // Return cleanup function
            return async () => {
                log?.info?.(`[${account.accountId}] stopping Webex provider`);
                unregister();
            };
        },
    },
};
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiY2hhbm5lbC1wbHVnaW4uanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi9zcmMvY2hhbm5lbC1wbHVnaW4udHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IjtBQUFBOzs7O0dBSUc7OztBQWdCSCw0Q0FFQztBQXVFRCxnRUFTQztBQWtDRCxvREE0R0M7QUF2T0QsaUNBQXFDO0FBQ3JDLHVDQUFnRDtBQUdoRCxvREFBb0Q7QUFDcEQsSUFBSSxhQUFhLEdBQXlCLElBQUksQ0FBQztBQUUvQyxTQUFnQixnQkFBZ0IsQ0FBQyxPQUFzQjtJQUNyRCxhQUFhLEdBQUcsT0FBTyxDQUFDO0FBQzFCLENBQUM7QUFrREQsTUFBTSxrQkFBa0IsR0FBRyxTQUFTLENBQUM7QUFTckMsTUFBTSxjQUFjLEdBQUcsSUFBSSxHQUFHLEVBQThCLENBQUM7QUFFN0QsU0FBUyxvQkFBb0IsQ0FBQyxHQUFXO0lBQ3ZDLE1BQU0sT0FBTyxHQUFHLEdBQUcsQ0FBQyxJQUFJLEVBQUUsQ0FBQztJQUMzQixJQUFJLENBQUMsT0FBTztRQUFFLE9BQU8sR0FBRyxDQUFDO0lBQ3pCLE1BQU0sU0FBUyxHQUFHLE9BQU8sQ0FBQyxVQUFVLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDLE9BQU8sQ0FBQyxDQUFDLENBQUMsSUFBSSxPQUFPLEVBQUUsQ0FBQztJQUNwRSxJQUFJLFNBQVMsQ0FBQyxNQUFNLEdBQUcsQ0FBQyxJQUFJLFNBQVMsQ0FBQyxRQUFRLENBQUMsR0FBRyxDQUFDLEVBQUUsQ0FBQztRQUNwRCxPQUFPLFNBQVMsQ0FBQyxLQUFLLENBQUMsQ0FBQyxFQUFFLENBQUMsQ0FBQyxDQUFDLENBQUM7SUFDaEMsQ0FBQztJQUNELE9BQU8sU0FBUyxDQUFDO0FBQ25CLENBQUM7QUFFRCxTQUFnQiwwQkFBMEIsQ0FDeEMsSUFBWSxFQUNaLE1BQTBCO0lBRTFCLE1BQU0sR0FBRyxHQUFHLG9CQUFvQixDQUFDLElBQUksQ0FBQyxDQUFDO0lBQ3ZDLGNBQWMsQ0FBQyxHQUFHLENB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QyxNQUFNO2dCQUN0QixjQUFjO2FBQ2YsQ0FBQyxDQUFDO1lBRUgsR0FBRyxFQUFFLElBQUksRUFBRSxDQUNULElBQUksT0FBTyxDQUFDLFNBQVMsd0NBQXdDLFdBQVcsRUFBRSxDQUMzRSxDQUFDO1lBRUYsMEJBQTBCO1lBQzFCLE9BQU8sS0FBSyxJQUFJLEVBQUU7Z0JBQ2hCLEdBQUcsRUFBRSxJQUFJLEVBQUUsQ0FBQyxJQUFJLE9BQU8sQ0FBQyxTQUFTLDJCQUEyQixDQUFDLENBQUM7Z0JBQzlELFVBQVUsRUFBRSxDQUFDO1lBQ2YsQ0FBQyxDQUFDO1FBQ0osQ0FBQztLQUNGO0NBQ0YsQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogT3BlbkNsYXcgQ2hhbm5lbCBQbHVnaW4gZm9yIFdlYmV4XG4gKlxuICogSW1wbGVtZW50cyB0aGUgQ2hhbm5lbFBsdWdpbiBpbnRlcmZhY2UgZm9yIE9wZW5DbGF3J3MgcGx1Z2luIHN5c3RlbS5cbiAqL1xuXG5pbXBvcnQgdHlwZSB7IEluY29taW5nTWVzc2FnZSwgU2VydmVyUmVzcG9uc2UgfSBmcm9tIFwibm9kZTpodHRwXCI7XG5cbmltcG9ydCB0eXBlIHtcbiAgQ2hhbm5lbFBsdWdpbixcbiAgUGx1Z2luUnVudGltZSxcbn0gZnJvbSBcIm9wZW5jbGF3L3BsdWdpbi1zZGtcIjtcblxuaW1wb3J0IHsgV2ViZXhTZW5kZXIgfSBmcm9tIFwiLi9zZW5kXCI7XG5pbXBvcnQgeyBXZWJleFdlYmhvb2tIYW5kbGVyIH0gZnJvbSBcIi4vd2ViaG9va1wiO1xuaW1wb3J0IHR5cGUgeyBXZWJleENoYW5uZWxDb25maWcsIFdlYmV4V2ViaG9va1BheWxvYWQgfSBmcm9tIFwiLi90eXBlc1wiO1xuXG4vLyBTdG9yZSB0aGUgcGx1Z2luIHJ1bnRpbWUgZm9yIHVzZSBpbiBIVFRQIGhhbmRsZXJzXG5sZXQgcGx1Z2luUnVudGltZTogUGx1Z2luUnVudGltZSB8IG51bGwgPSBudWxsO1xuXG5leHBvcnQgZnVuY3Rpb24gc2V0UGx1Z2luUnVudGltZShydW50aW1lOiBQbHVnaW5SdW50aW1lKTogdm9pZCB7XG4gIHBsdWdpblJ1bnRpbWUgPSBydW50aW1lO1xufVxuXG4vKiogUmVzb2x2ZWQgYWNjb3VudCBjb25maWd1cmF0aW9uICovXG5leHBvcnQgaW50ZXJmYWNlIFJlc29sdmVkV2ViZXhBY2NvdW50IHtcbiAgYWNjb3VudElkOiBzdHJpbmc7XG4gIG5hbWU/OiBzdHJpbmc7XG4gIGVuYWJsZWQ6IGJvb2xlYW47XG4gIGNvbmZpZ3VyZWQ6IGJvb2xlYW47XG4gIGNvbmZpZzogV2ViZXhDaGFubmVsQ29uZmlnO1xuICB0b2tlbj86IHN0cmluZztcbiAgd2ViaG9va1VybD86IHN0cmluZztcbn1cblxuLyoqIENvcmUgY29uZmlnIHR5cGUgZm9yIGFjY2Vzc2luZyBjaGFubmVscy53ZWJleCAqL1xuaW50ZXJmYWNlIENvcmVDb25maWcge1xuICBjaGFubmVscz86IHtcbiAgICB3ZWJleD86IFdlYmV4Q2hhbm5lbFNlY3Rpb247XG4gICAgZGVmYXVsdHM/OiB7XG4gICAgICBncm91cFBvbGljeT86IHN0cmluZztcbiAgICB9O1xuICB9O1xufVxuXG5pbnRlcmZhY2UgV2ViZXhDaGFubmVsU2VjdGlvbiB7XG4gIGVuYWJsZWQ/OiBib29sZWFuO1xuICBuYW1lPzogc3RyaW5nO1xuICB0b2tlbj86IHN0cmluZztcbiAgd2ViaG9va1VybD86IHN0cmluZztcbiAgd2ViaG9va1NlY3JldD86IHN0cmluZztcbiAgZG1Qb2xpY3k/OiBcImFsbG93XCIgfCBcImRlbnlcIiB8IFwiYWxsb3dsaXN0ZWRcIiB8IFwicGFpcmluZ1wiO1xuICBhbGxvd0Zyb20/OiBzdHJpbmdbXTtcbiAgYXBpQmFzZVVybD86IHN0cmluZztcbiAgbWF4UmV0cmllcz86IG51bWJlcjtcbiAgcmV0cnlEZWxheU1zPzogbnVtYmVyO1xuICBhY2NvdW50cz86IFJlY29yZDxzdHJpbmcsIFdlYmV4QWNjb3VudENvbmZpZz47XG59XG5cbmludGVyZmFjZSBXZWJleEFjY291bnRDb25maWcge1xuICBlbmFibGVkPzogYm9vbGVhbjtcbiAgbmFtZT86IHN0cmluZztcbiAgdG9rZW4/OiBzdHJpbmc7XG4gIHdlYmhvb2tVcmw/OiBzdHJpbmc7XG4gIHdlYmhvb2tTZWNyZXQ/OiBzdHJpbmc7XG4gIGRtUG9saWN5PzogXCJhbGxvd1wiIHwgXCJkZW55XCIgfCBcImFsbG93bGlzdGVkXCIgfCBcInBhaXJpbmdcIjtcbiAgYWxsb3dGcm9tPzogc3RyaW5nW107XG4gIGFwaUJhc2VVcmw/OiBzdHJpbmc7XG4gIG1heFJldHJpZXM/OiBudW1iZXI7XG4gIHJldHJ5RGVsYXlNcz86IG51bWJlcjtcbn1cblxuY29uc3QgREVGQVVMVF9BQ0NPVU5UX0lEID0gXCJkZWZhdWx0XCI7XG5cbi8qKiBXZWJob29rIHRhcmdldCByZWdpc3RyYXRpb24gZm9yIEhUVFAgaGFuZGxlciAqL1xudHlwZSBXZWJleFdlYmhvb2tUYXJnZXQgPSB7XG4gIGFjY291bnQ6IFJlc29sdmVkV2ViZXhBY2NvdW50O1xuICBjb25maWc6IFdlYmV4Q2hhbm5lbENvbmZpZztcbiAgd2ViaG9va0hhbmRsZXI6IFdlYmV4V2ViaG9va0hhbmRsZXI7XG59O1xuXG5jb25zdCB3ZWJob29rVGFyZ2V0cyA9IG5ldyBNYXA8c3RyaW5nLCBXZWJleFdlYmhvb2tUYXJnZXQ+KCk7XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZVdlYmhvb2tQYXRoKHJhdzogc3RyaW5nKTogc3RyaW5nIHtcbiAgY29uc3QgdHJpbW1lZCA9IHJhdy50cmltKCk7XG4gIGlmICghdHJpbW1lZCkgcmV0dXJuIFwiL1wiO1xuICBjb25zdCB3aXRoU2xhc2ggPSB0cmltbWVkLnN0YXJ0c1dpdGgoXCIvXCIpID8gdHJpbW1lZCA6IGAvJHt0cmltbWVkfWA7XG4gIGlmICh3aXRoU2xhc2gubGVuZ3RoID4gMSAmJiB3aXRoU2xhc2guZW5kc1dpdGgoXCIvXCIpKSB7XG4gICAgcmV0dXJuIHdpdGhTbGFzaC5zbGljZSgwLCAtMSk7XG4gIH1cbiAgcmV0dXJuIHdpdGhTbGFzaDtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHJlZ2lzdGVyV2ViZXhXZWJob29rVGFyZ2V0KFxuICBwYXRoOiBzdHJpbmcsXG4gIHRhcmdldDogV2ViZXhXZWJob29rVGFyZ2V0XG4pOiAoKSA9PiB2b2lkIHtcbiAgY29uc3Qga2V5ID0gbm9ybWFsaXplV2ViaG9va1BhdGgocGF0aCk7XG4gIHdlYmhvb2tUYXJnZXRzLnNldChrZXksIHRhcmdldCk7XG4gIHJldHVybiAoKSA9PiB7XG4gICAgd2ViaG9va1RhcmdldHMuZGVsZXRlKGtleSk7XG4gIH07XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHJlYWRKc29uQm9keShyZXE6IEluY29taW5nTWVzc2FnZSwgbWF4Qnl0ZXM6IG51bWJlcik6IFByb21pc2U8eyBvazogYm9vbGVhbjsgdmFsdWU/OiB1bmtub3duOyBlcnJvcj86IHN0cmluZyB9PiB7XG4gIGNvbnN0IGNodW5rczogQnVmZmVyW10gPSBbXTtcbiAgbGV0IHRvdGFsID0gMDtcbiAgcmV0dXJuIGF3YWl0IG5ldyBQcm9taXNlKChyZXNvbHZlKSA9PiB7XG4gICAgcmVxLm9uKFwiZGF0YVwiLCAoY2h1bms6IEJ1ZmZlcikgPT4ge1xuICAgICAgdG90YWwgKz0gY2h1bmsubGVuZ3RoO1xuICAgICAgaWYgKHRvdGFsID4gbWF4Qnl0ZXMpIHtcbiAgICAgICAgcmVzb2x2ZSh7IG9rOiBmYWxzZSwgZXJyb3I6IFwicGF5bG9hZCB0b28gbGFyZ2VcIiB9KTtcbiAgICAgICAgcmVxLmRlc3Ryb3koKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgY2h1bmtzLnB1c2goY2h1bmspO1xuICAgIH0pO1xuICAgIHJlcS5vbihcImVuZFwiLCAoKSA9PiB7XG4gICAgICB0cnkge1xuICAgICAgICBjb25zdCBib2R5ID0gQnVmZmVyLmNvbmNhdChjaHVua3MpLnRvU3RyaW5nKFwidXRmLThcIik7XG4gICAgICAgIGNvbnN0IHBhcnNlZCA9IEpTT04ucGFyc2UoYm9keSk7XG4gICAgICAgIHJlc29sdmUoeyBvazogdHJ1ZSwgdmFsdWU6IHBhcnNlZCB9KTtcbiAgICAgIH0gY2F0Y2gge1xuICAgICAgICByZXNvbHZlKHsgb2s6IGZhbHNlLCBlcnJvcjogXCJpbnZhbGlkIGpzb25cIiB9KTtcbiAgICAgIH1cbiAgICB9KTtcbiAgICByZXEub24oXCJlcnJvclwiLCAoZXJyKSA9PiB7XG4gICAgICByZXNvbHZlKHsgb2s6IGZhbHNlLCBlcnJvcjogZXJyLm1lc3NhZ2UgfSk7XG4gICAgfSk7XG4gIH0pO1xufVxuXG4vKipcbiAqIENyZWF0ZSB0aGUgd2ViaG9vayBoYW5kbGVyIHdpdGggYWNjZXNzIHRvIHRoZSBwbHVnaW4gcnVudGltZS5cbiAqIFJldHVybnMgYSBoYW5kbGVyIGZ1bmN0aW9uIHRoYXQgY2FuIHByb2Nlc3MgaW5jb21pbmcgV2ViZXggd2ViaG9vayByZXF1ZXN0cy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGNyZWF0ZVdlYmhvb2tIYW5kbGVyKCk6IChyZXE6IEluY29taW5nTWVzc2FnZSwgcmVzOiBTZXJ2ZXJSZXNwb25zZSkgPT4gUHJvbWlzZTxib29sZWFuPiB7XG4gIHJldHVybiBhc3luYyAocmVxOiBJbmNvbWluZ01lc3NhZ2UsIHJlczogU2VydmVyUmVzcG9uc2UpOiBQcm9taXNlPGJvb2xlYW4+ID0+IHtcbiAgICBjb25zdCB1cmwgPSBuZXcgVVJMKHJlcS51cmwgPz8gXCIvXCIsIFwiaHR0cDovL2xvY2FsaG9zdFwiKTtcbiAgICBjb25zdCBwYXRoID0gbm9ybWFsaXplV2ViaG9va1BhdGgodXJsLnBhdGhuYW1lKTtcblxuICAgIC8vIENoZWNrIGlmIHBhdGggbWF0Y2hlcyAvd2ViaG9va3Mvd2ViZXgvKlxuICAgIGlmICghcGF0aC5zdGFydHNXaXRoKFwiL3dlYmhvb2tzL3dlYmV4L1wiKSkge1xuICAgICAgcmV0dXJuIGZhbHNlO1xuICAgIH1cblxuICAgIGNvbnN0IHRhcmdldCA9IHdlYmhvb2tUYXJnZXRzLmdldChwYXRoKTtcbiAgICBpZiAoIXRhcmdldCkge1xuICAgICAgcmV0dXJuIGZhbHNlO1xuICAgIH1cblxuICAgIGlmIChyZXEubWV0aG9kICE9PSBcIlBPU1RcIikge1xuICAgICAgcmVzLnN0YXR1c0NvZGUgPSA0MDU7XG4gICAgICByZXMuc2V0SGVhZGVyKFwiQWxsb3dcIiwgXCJQT1NUXCIpO1xuICAgICAgcmVzLmVuZChcIk1ldGhvZCBOb3QgQWxsb3dlZFwiKTtcbiAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cblxuICAgIGNvbnN0IGJvZHkgPSBhd2FpdCByZWFkSnNvbkJvZHkocmVxLCAxMDI0ICogMTAyNCk7XG4gICAgaWYgKCFib2R5Lm9rKSB7XG4gICAgICByZXMuc3RhdHVzQ29kZSA9IGJvZHkuZXJyb3IgPT09IFwicGF5bG9hZCB0b28gbGFyZ2VcIiA/IDQxMyA6IDQwMDtcbiAgICAgIHJlcy5lbmQoYm9keS5lcnJvciA/PyBcImludmFsaWQgcGF5bG9hZFwiKTtcbiAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cblxuICAgIGNvbnN0IHsgYWNjb3VudCwgd2ViaG9va0hhbmRsZXIgfSA9IHRhcmdldDtcblxuICAgIHRyeSB7XG4gICAgICBjb25zdCBzaWduYXR1cmUgPSByZXEuaGVhZGVyc1tcIngtc3Bhcmstc2lnbmF0dXJlXCJdIGFzIHN0cmluZyB8IHVuZGVmaW5lZDtcbiAgICAgIGNvbnN0IHBheWxvYWQgPSBib2R5LnZhbHVlIGFzIFdlYmV4V2ViaG9va1BheWxvYWQ7XG5cbiAgICAgIGNvbnN0IGVudmVsb3BlID0gYXdhaXQgd2ViaG9va0hhbmRsZXIuaGFuZGxlV2ViaG9vayhwYXlsb2FkLCBzaWduYXR1cmUpO1xuXG4gICAgICBpZiAoZW52ZWxvcGUgJiYgcGx1Z2luUnVudGltZSkge1xuICAgICAgICAvLyBMb2FkIGNvbmZpZyB1c2luZyB0aGUgcGx1Z2luIHJ1bnRpbWUgKGNhc3QgdG8gYW55IGZvciBpbnRlcm5hbCBBUEkgYWNjZXNzKVxuICAgICAgICBjb25zdCBydW50aW1lID0gcGx1Z2luUnVudGltZSBhcyBhbnk7XG4gICAgICAgIGNvbnN0IGNmZyA9IHJ1bnRpbWUuY29uZmlnPy5sb2FkQ29uZmlnPy4oKSA/PyB7fTtcbiAgICAgICAgXG4gICAgICAgIC8vIEJ1aWxkIHRoZSBjb250ZXh0IHBheWxvYWQgZm9yIE9wZW5DbGF3J3MgbWVzc2FnZSBwaXBlbGluZVxuICAgICAgICBjb25zdCBjdHhQYXlsb2FkID0ge1xuICAgICAgICAgIEJvZHk6IGVudmVsb3BlLmNvbnRlbnQudGV4dCA/PyBcIlwiLFxuICAgICAgICAgIFJhd0JvZHk6IGVudmVsb3BlLmNvbnRlbnQudGV4dCA/PyBcIlwiLFxuICAgICAgICAgIENvbW1hbmRCb2R5OiBlbnZlbG9wZS5jb250ZW50LnRleHQgPz8gXCJcIixcbiAgICAgICAgICBGcm9tOiBgd2ViZXg6JHtlbnZlbG9wZS5hdXRob3IuaWR9YCxcbiAgICAgICAgICBUbzogYHdlYmV4OiR7ZW52ZWxvcGUuY29udmVyc2F0aW9uSWR9YCxcbiAgICAgICAgICBTZXNzaW9uS2V5OiBgYWdlbnQ6bWFpbjp3ZWJleDoke2VudmVsb3BlLmNvbnZlcnNhdGlvbklkfWAsXG4gICAgICAgICAgQWNjb3VudElkOiBhY2NvdW50LmFjY291bnRJZCxcbiAgICAgICAgICBDaGF0VHlwZTogZW52ZWxvcGUubWV0YWRhdGEucm9vbVR5cGUgPT09IFwiZGlyZWN0XCIgPyBcImRpcmVjdFwiIDogXCJncm91cFwiLFxuICAgICAgICAgIFNlbmRlck5hbWU6IGVudmVsb3BlLmF1dGhvci5kaXNwbGF5TmFtZSA/PyBlbnZlbG9wZS5hdXRob3IuZW1haWwgPz8gZW52ZWxvcGUuYXV0aG9yLmlkLFxuICAgICAgICAgIFNlbmRlcklkOiBlbnZlbG9wZS5hdXRob3IuaWQsXG4gICAgICAgICAgUHJvdmlkZXI6IFwid2ViZXhcIixcbiAgICAgICAgICBTdXJmYWNlOiBcIndlYmV4XCIsXG4gICAgICAgICAgTWVzc2FnZVNpZDogZW52ZWxvcGUuaWQsXG4gICAgICAgICAgVGltZXN0YW1wOiBlbnZlbG9wZS5tZXRhZGF0YS50aW1lc3RhbXAsXG4gICAgICAgICAgT3JpZ2luYXRpbmdDaGFubmVsOiBcIndlYmV4XCIsXG4gICAgICAgICAgT3JpZ2luYXRpbmdUbzogYHdlYmV4OiR7ZW52ZWxvcGUuY29udmVyc2F0aW9uSWR9YCxcbiAgICAgICAgICBNZXNzYWdlVGhyZWFkSWQ6IGVudmVsb3BlLm1ldGFkYXRhLnBhcmVudElkLFxuICAgICAgICB9O1xuXG4gICAgICAgIC8vIFVzZSB0aGUgcGx1Z2luIHJ1bnRpbWUncyBkaXNwYXRjaCBmdW5jdGlvbiAoY2FzdCB0byBhbnkgZm9yIGludGVybmFsIEFQSSlcbiAgICAgICAgY29uc3QgZGlzcGF0Y2hSZXBseSA9IHJ1bnRpbWUuY2hhbm5lbD8ucmVwbHk/LmRpc3BhdGNoUmVwbHlXaXRoQnVmZmVyZWRCbG9ja0Rpc3BhdGNoZXI7XG4gICAgICAgIFxuICAgICAgICBpZiAoZGlzcGF0Y2hSZXBseSkge1xuICAgICAgICAgIC8vIENyZWF0ZSBhIHNlbmRlciBmb3IgcmVwbGllc1xuICAgICAgICAgIGNvbnN0IHNlbmRlciA9IG5ldyBXZWJleFNlbmRlcihhY2NvdW50LmNvbmZpZyk7XG4gICAgICAgICAgXG4gICAgICAgICAgYXdhaXQgZGlzcGF0Y2hSZXBseSh7XG4gICAgICAgICAgICBjdHg6IGN0eFBheWxvYWQsXG4gICAgICAgICAgICBjZmcsXG4gICAgICAgICAgICBkaXNwYXRjaGVyT3B0aW9uczoge1xuICAgICAgICAgICAgICBkZWxpdmVyOiBhc3luYyAocGF5bG9hZDogeyB0ZXh0Pzogc3RyaW5nOyBtZWRpYT86IHN0cmluZyB9KSA9PiB7XG4gICAgICAgICAgICAgICAgaWYgKHBheWxvYWQudGV4dCkge1xuICAgICAgICAgICAgICAgICAgYXdhaXQgc2VuZGVyLnNlbmQoe1xuICAgICAgICAgICAgICAgICAgICB0bzogZW52ZWxvcGUuY29udmVyc2F0aW9uSWQsXG4gICAgICAgICAgICAgICAgICAgIGNvbnRlbnQ6IHsgdGV4dDogcGF5bG9hZC50ZXh0IH0sXG4gICAgICAgICAgICAgICAgICAgIHBhcmVudElkOiBlbnZlbG9wZS5tZXRhZGF0YS5wYXJlbnRJZCxcbiAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgb25FcnJvcjogKGVycjogRXJyb3IpID0+IHtcbiAgICAgICAgICAgICAgICBjb25zb2xlLmVycm9yKGBbd2ViZXg6JHthY2NvdW50LmFjY291bnRJZH1dIHJlcGx5IGRpc3BhdGNoIGVycm9yOiAke2Vyci5tZXNzYWdlfWApO1xuICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICAgIHJlcGx5T3B0aW9uczoge30sXG4gICAgICAgICAgfSk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgY29uc29sZS53YXJuKGBbd2ViZXg6JHthY2NvdW50LmFjY291bnRJZH1dIGRpc3BhdGNoUmVwbHkgbm90IGF2YWlsYWJsZSBpbiBwbHVnaW4gcnVudGltZWApO1xuICAgICAgICB9XG4gICAgICB9XG5cbiAgICAgIHJlcy5zdGF0dXNDb2RlID0gMjAwO1xuICAgICAgcmVzLnNldEhlYWRlcihcIkNvbnRlbnQtVHlwZVwiLCBcImFwcGxpY2F0aW9uL2pzb25cIik7XG4gICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KHsgb2s6IHRydWUgfSkpO1xuICAgICAgcmV0dXJuIHRydWU7XG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICBjb25zb2xlLmVycm9yKFxuICAgICAgICBgW3dlYmV4OiR7YWNjb3VudC5hY2NvdW50SWR9XSB3ZWJob29rIGVycm9yOiAke2VyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBlcnJ9YFxuICAgICAgKTtcbiAgICAgIHJlcy5zdGF0dXNDb2RlID0gNTAwO1xuICAgICAgcmVzLnNldEhlYWRlcihcIkNvbnRlbnQtVHlwZVwiLCBcImFwcGxpY2F0aW9uL2pzb25cIik7XG4gICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KHsgZXJyb3I6IFwiSW50ZXJuYWwgZXJyb3JcIiB9KSk7XG4gICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG4gIH07XG59XG5cbmZ1bmN0aW9uIGxpc3RXZWJleEFjY291bnRJZHMoY2ZnOiBDb3JlQ29uZmlnKTogc3RyaW5nW10ge1xuICBjb25zdCBzZWN0aW9uID0gY2ZnLmNoYW5uZWxzPy53ZWJleDtcbiAgaWYgKCFzZWN0aW9uKSByZXR1cm4gW107XG5cbiAgY29uc3QgaWRzOiBzdHJpbmdbXSA9IFtdO1xuXG4gIC8vIENoZWNrIGZvciB0b3AtbGV2ZWwgY29uZmlnIChkZWZhdWx0IGFjY291bnQpXG4gIGlmIChzZWN0aW9uLnRva2VuKSB7XG4gICAgaWRzLnB1c2goREVGQVVMVF9BQ0NPVU5UX0lEKTtcbiAgfVxuXG4gIC8vIENoZWNrIGZvciBuYW1lZCBhY2NvdW50c1xuICBpZiAoc2VjdGlvbi5hY2NvdW50cykge1xuICAgIGZvciAoY29uc3QgaWQgb2YgT2JqZWN0LmtleXMoc2VjdGlvbi5hY2NvdW50cykpIHtcbiAgICAgIGlmIChpZCAhPT0gREVGQVVMVF9BQ0NPVU5UX0lEKSB7XG4gICAgICAgIGlkcy5wdXNoKGlkKTtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICByZXR1cm4gaWRzO1xufVxuXG5mdW5jdGlvbiByZXNvbHZlV2ViZXhBY2NvdW50KG9wdHM6IHtcbiAgY2ZnOiBDb3JlQ29uZmlnO1xuICBhY2NvdW50SWQ/OiBzdHJpbmc7XG59KTogUmVzb2x2ZWRXZWJleEFjY291bnQge1xuICBjb25zdCB7IGNmZywgYWNjb3VudElkID0gREVGQVVMVF9BQ0NPVU5UX0lEIH0gPSBvcHRzO1xuICBjb25zdCBzZWN0aW9uID0gY2ZnLmNoYW5uZWxzPy53ZWJleDtcblxuICBpZiAoIXNlY3Rpb24pIHtcbiAgICByZXR1cm4ge1xuICAgICAgYWNjb3VudElkLFxuICAgICAgZW5hYmxlZDogZmFsc2UsXG4gICAgICBjb25maWd1cmVkOiBmYWxzZSxcbiAgICAgIGNvbmZpZzoge30gYXMgV2ViZXhDaGFubmVsQ29uZmlnLFxuICAgIH07XG4gIH1cblxuICAvLyBDaGVjayBmb3IgbmFtZWQgYWNjb3VudCBmaXJzdFxuICBjb25zdCBuYW1lZEFjY291bnQgPSBzZWN0aW9uLmFjY291bnRzPy5bYWNjb3VudElkXTtcblxuICBpZiAobmFtZWRBY2NvdW50KSB7XG4gICAgY29uc3QgdG9rZW4gPSBuYW1lZEFjY291bnQudG9rZW4gPz8gc2VjdGlvbi50b2tlbjtcbiAgICBjb25zdCB3ZWJob29rVXJsID0gbmFtZWRBY2NvdW50LndlYmhvb2tVcmwgPz8gc2VjdGlvbi53ZWJob29rVXJsO1xuXG4gICAgcmV0dXJuIHtcbiAgICAgIGFjY291bnRJZCxcbiAgICAgIG5hbWU6IG5hbWVkQWNjb3VudC5uYW1lLFxuICAgICAgZW5hYmxlZDogbmFtZWRBY2NvdW50LmVuYWJsZWQgIT09IGZhbHNlLFxuICAgICAgY29uZmlndXJlZDogQm9vbGVhbih0b2tlbiAmJiB3ZWJob29rVXJsKSxcbiAgICAgIHRva2VuLFxuICAgICAgd2ViaG9va1VybCxcbiAgICAgIGNvbmZpZzoge1xuICAgICAgICB0b2tlbjogdG9rZW4gPz8gXCJcIixcbiAgICAgICAgd2ViaG9va1VybDogd2ViaG9va1VybCA/PyBcIlwiLFxuICAgICAgICB3ZWJob29rU2VjcmV0OiBuYW1lZEFjY291bnQud2ViaG9va1NlY3JldCA/PyBzZWN0aW9uLndlYmhvb2tTZWNyZXQsXG4gICAgICAgIGRtUG9saWN5OiBuYW1lZEFjY291bnQuZG1Qb2xpY3kgPz8gc2VjdGlvbi5kbVBvbGljeSA/PyBcImFsbG93XCIsXG4gICAgICAgIGFsbG93RnJvbTogbmFtZWRBY2NvdW50LmFsbG93RnJvbSA/PyBzZWN0aW9uLmFsbG93RnJvbSxcbiAgICAgICAgYXBpQmFzZVVybDogbmFtZWRBY2NvdW50LmFwaUJhc2VVcmwgPz8gc2VjdGlvbi5hcGlCYXNlVXJsLFxuICAgICAgICBtYXhSZXRyaWVzOiBuYW1lZEFjY291bnQubWF4UmV0cmllcyA/PyBzZWN0aW9uLm1heFJldHJpZXMsXG4gICAgICAgIHJldHJ5RGVsYXlNczogbmFtZWRBY2NvdW50LnJldHJ5RGVsYXlNcyA/PyBzZWN0aW9uLnJldHJ5RGVsYXlNcyxcbiAgICAgIH0sXG4gICAgfTtcbiAgfVxuXG4gIC8vIEZhbGwgYmFjayB0byB0b3AtbGV2ZWwgY29uZmlnIChkZWZhdWx0IGFjY291bnQpXG4gIGlmIChhY2NvdW50SWQgPT09IERFRkFVTFRfQUNDT1VOVF9JRCkge1xuICAgIHJldHVybiB7XG4gICAgICBhY2NvdW50SWQsXG4gICAgICBuYW1lOiBzZWN0aW9uLm5hbWUsXG4gICAgICBlbmFibGVkOiBzZWN0aW9uLmVuYWJsZWQgIT09IGZhbHNlLFxuICAgICAgY29uZmlndXJlZDogQm9vbGVhbihzZWN0aW9uLnRva2VuICYmIHNlY3Rpb24ud2ViaG9va1VybCksXG4gICAgICB0b2tlbjogc2VjdGlvbi50b2tlbixcbiAgICAgIHdlYmhvb2tVcmw6IHNlY3Rpb24ud2ViaG9va1VybCxcbiAgICAgIGNvbmZpZzoge1xuICAgICAgICB0b2tlbjogc2VjdGlvbi50b2tlbiA/PyBcIlwiLFxuICAgICAgICB3ZWJob29rVXJsOiBzZWN0aW9uLndlYmhvb2tVcmwgPz8gXCJcIixcbiAgICAgICAgd2ViaG9va1NlY3JldDogc2VjdGlvbi53ZWJob29rU2VjcmV0LFxuICAgICAgICBkbVBvbGljeTogc2VjdGlvbi5kbVBvbGljeSA/PyBcImFsbG93XCIsXG4gICAgICAgIGFsbG93RnJvbTogc2VjdGlvbi5hbGxvd0Zyb20sXG4gICAgICAgIGFwaUJhc2VVcmw6IHNlY3Rpb24uYXBpQmFzZVVybCxcbiAgICAgICAgbWF4UmV0cmllczogc2VjdGlvbi5tYXhSZXRyaWVzLFxuICAgICAgICByZXRyeURlbGF5TXM6IHNlY3Rpb24ucmV0cnlEZWxheU1zLFxuICAgICAgfSxcbiAgICB9O1xuICB9XG5cbiAgLy8gQWNjb3VudCBub3QgZm91bmRcbiAgcmV0dXJuIHtcbiAgICBhY2NvdW50SWQsXG4gICAgZW5hYmxlZDogZmFsc2UsXG4gICAgY29uZmlndXJlZDogZmFsc2UsXG4gICAgY29uZmlnOiB7fSBhcyBXZWJleENoYW5uZWxDb25maWcsXG4gIH07XG59XG5cbmNvbnN0IG1ldGEgPSB7XG4gIGlkOiBcIndlYmV4XCIsXG4gIGxhYmVsOiBcIldlYmV4XCIsXG4gIHNlbGVjdGlvbkxhYmVsOiBcIkNpc2NvIFdlYmV4XCIsXG4gIGRvY3NQYXRoOiBcIi9jaGFubmVscy93ZWJleFwiLFxuICBkb2NzTGFiZWw6IFwid2ViZXhcIixcbiAgYmx1cmI6IFwiQ2lzY28gV2ViZXggbWVzc2FnaW5nIHZpYSBib3Qgd2ViaG9va3MuXCIsXG4gIG9yZGVyOiA3NSxcbiAgYWxpYXNlczogW1wiY2lzY28td2ViZXhcIl0sXG59O1xuXG5leHBvcnQgY29uc3Qgd2ViZXhQbHVnaW46IENoYW5uZWxQbHVnaW48UmVzb2x2ZWRXZWJleEFjY291bnQ+ID0ge1xuICBpZDogXCJ3ZWJleFwiLFxuICBtZXRhLFxuXG4gIGNhcGFiaWxpdGllczoge1xuICAgIGNoYXRUeXBlczogW1wiZGlyZWN0XCIsIFwiZ3JvdXBcIl0sXG4gICAgdGhyZWFkczogdHJ1ZSxcbiAgICBtZWRpYTogdHJ1ZSxcbiAgfSxcblxuICByZWxvYWQ6IHsgY29uZmlnUHJlZml4ZXM6IFtcImNoYW5uZWxzLndlYmV4XCJdIH0sXG5cbiAgY29uZmlnOiB7XG4gICAgbGlzdEFjY291bnRJZHM6IChjZmcpID0+IGxpc3RXZWJleEFjY291bnRJZHMoY2ZnIGFzIENvcmVDb25maWcpLFxuXG4gICAgcmVzb2x2ZUFjY291bnQ6IChjZmcsIGFjY291bnRJZCkgPT5cbiAgICAgIHJlc29sdmVXZWJleEFjY291bnQoeyBjZmc6IGNmZyBhcyBDb3JlQ29uZmlnLCBhY2NvdW50SWQgfSksXG5cbiAgICBkZWZhdWx0QWNjb3VudElkOiAoKSA9PiBERUZBVUxUX0FDQ09VTlRfSUQsXG5cbiAgICBzZXRBY2NvdW50RW5hYmxlZDogKHsgY2ZnLCBhY2NvdW50SWQsIGVuYWJsZWQgfSkgPT4ge1xuICAgICAgY29uc3QgY29uZmlnID0gY2ZnIGFzIENvcmVDb25maWc7XG4gICAgICBjb25zdCBzZWN0aW9uID0gY29uZmlnLmNoYW5uZWxzPy53ZWJleCA/PyB7fTtcblxuICAgICAgaWYgKGFjY291bnRJZCA9PT0gREVGQVVMVF9BQ0NPVU5UX0lEKSB7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgLi4uY29uZmlnLFxuICAgICAgICAgIGNoYW5uZWxzOiB7XG4gICAgICAgICAgICAuLi5jb25maWcuY2hhbm5lbHMsXG4gICAgICAgICAgICB3ZWJleDoge1xuICAgICAgICAgICAgICAuLi5zZWN0aW9uLFxuICAgICAgICAgICAgICBlbmFibGVkLFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICB9LFxuICAgICAgICB9O1xuICAgICAgfVxuXG4gICAgICByZXR1cm4ge1xuICAgICAgICAuLi5jb25maWcsXG4gICAgICAgIGNoYW5uZWxzOiB7XG4gICAgICAgICAgLi4uY29uZmlnLmNoYW5uZWxzLFxuICAgICAgICAgIHdlYmV4OiB7XG4gICAgICAgICAgICAuLi5zZWN0aW9uLFxuICAgICAgICAgICAgYWNjb3VudHM6IHtcbiAgICAgICAgICAgICAgLi4uc2VjdGlvbi5hY2NvdW50cyxcbiAgICAgICAgICAgICAgW2FjY291bnRJZF06IHtcbiAgICAgICAgICAgICAgICAuLi5zZWN0aW9uLmFjY291bnRzPy5bYWNjb3VudElkXSxcbiAgICAgICAgICAgICAgICBlbmFibGVkLFxuICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICB9LFxuICAgICAgICB9LFxuICAgICAgfTtcbiAgICB9LFxuXG4gICAgZGVsZXRlQWNjb3VudDogKHsgY2ZnLCBhY2NvdW50SWQgfSkgPT4ge1xuICAgICAgY29uc3QgY29uZmlnID0gY2ZnIGFzIENvcmVDb25maWc7XG4gICAgICBjb25zdCBzZWN0aW9uID0gY29uZmlnLmNoYW5uZWxzPy53ZWJleCA/PyB7fTtcblxuICAgICAgaWYgKGFjY291bnRJZCA9PT0gREVGQVVMVF9BQ0NPVU5UX0lEKSB7XG4gICAgICAgIGNvbnN0IHsgdG9rZW4sIHdlYmhvb2tVcmwsIHdlYmhvb2tTZWNyZXQsIGRtUG9saWN5LCBhbGxvd0Zyb20sIC4uLnJlc3QgfSA9IHNlY3Rpb247XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgLi4uY29uZmlnLFxuICAgICAgICAgIGNoYW5uZWxzOiB7XG4gICAgICAgICAgICAuLi5jb25maWcuY2hhbm5lbHMsXG4gICAgICAgICAgICB3ZWJleDogcmVzdCxcbiAgICAgICAgICB9LFxuICAgICAgICB9O1xuICAgICAgfVxuXG4gICAgICBjb25zdCBhY2NvdW50cyA9IHsgLi4uc2VjdGlvbi5hY2NvdW50cyB9O1xuICAgICAgZGVsZXRlIGFjY291bnRzW2FjY291bnRJZF07XG5cbiAgICAgIHJldHVybiB7XG4gICAgICAgIC4uLmNvbmZpZyxcbiAgICAgICAgY2hhbm5lbHM6IHtcbiAgICAgICAgICAuLi5jb25maWcuY2hhbm5lbHMsXG4gICAgICAgICAgd2ViZXg6IHtcbiAgICAgICAgICAgIC4uLnNlY3Rpb24sXG4gICAgICAgICAgICBhY2NvdW50cyxcbiAgICAgICAgICB9LFxuICAgICAgICB9LFxuICAgICAgfTtcbiAgICB9LFxuXG4gICAgaXNDb25maWd1cmVkOiAoYWNjb3VudCkgPT4gYWNjb3VudC5jb25maWd1cmVkLFxuXG4gICAgZGVzY3JpYmVBY2NvdW50OiAoYWNjb3VudCkgPT4gKHtcbiAgICAgIGFjY291bnRJZDogYWNjb3VudC5hY2NvdW50SWQsXG4gICAgICBuYW1lOiBhY2NvdW50Lm5hbWUsXG4gICAgICBlbmFibGVkOiBhY2NvdW50LmVuYWJsZWQsXG4gICAgICBjb25maWd1cmVkOiBhY2NvdW50LmNvbmZpZ3VyZWQsXG4gICAgICBiYXNlVXJsOiBhY2NvdW50LmNvbmZpZy5hcGlCYXNlVXJsID8/IFwiaHR0cHM6Ly93ZWJleGFwaXMuY29tL3YxXCIsXG4gICAgfSksXG5cbiAgICByZXNvbHZlQWxsb3dGcm9tOiAoeyBjZmcgfSkgPT5cbiAgICAgICgoY2ZnIGFzIENvcmVDb25maWcpLmNoYW5uZWxzPy53ZWJleD8uYWxsb3dGcm9tID8/IFtdKS5tYXAoU3RyaW5nKSxcblxuICAgIGZvcm1hdEFsbG93RnJvbTogKHsgYWxsb3dGcm9tIH0pID0+XG4gICAgICBhbGxvd0Zyb20ubWFwKChlbnRyeSkgPT4gZW50cnkudHJpbSgpLnRvTG93ZXJDYXNlKCkpLFxuICB9LFxuXG4gIHNlY3VyaXR5OiB7XG4gICAgcmVzb2x2ZURtUG9saWN5OiAoeyBhY2NvdW50IH0pID0+IHtcbiAgICAgIGNvbnN0IHBvbGljeSA9IGFjY291bnQuY29uZmlnLmRtUG9saWN5ID8/IFwiYWxsb3dcIjtcbiAgICAgIC8vIE1hcCBcImFsbG93bGlzdGVkXCIgdG8gXCJhbGxvd2xpc3RcIiBmb3IgT3BlbkNsYXcgY29tcGF0aWJpbGl0eVxuICAgICAgY29uc3Qgbm9ybWFsaXplZFBvbGljeSA9IHBvbGljeSA9PT0gXCJhbGxvd2xpc3RlZFwiID8gXCJhbGxvd2xpc3RcIiA6IHBvbGljeTtcblxuICAgICAgcmV0dXJuIHtcbiAgICAgICAgcG9saWN5OiBub3JtYWxpemVkUG9saWN5IGFzIFwiYWxsb3dcIiB8IFwiZGVueVwiIHwgXCJhbGxvd2xpc3RcIiB8IFwicGFpcmluZ1wiLFxuICAgICAgICBhbGxvd0Zyb206IGFjY291bnQuY29uZmlnLmFsbG93RnJvbSA/PyBbXSxcbiAgICAgICAgcG9saWN5UGF0aDogXCJjaGFubmVscy53ZWJleC5kbVBvbGljeVwiLFxuICAgICAgICBhbGxvd0Zyb21QYXRoOiBcImNoYW5uZWxzLndlYmV4LmFsbG93RnJvbVwiLFxuICAgICAgICBhcHByb3ZlSGludDogXCJBZGQgdXNlciBJRCBvciBlbWFpbCB0byBjaGFubmVscy53ZWJleC5hbGxvd0Zyb21cIixcbiAgICAgICAgbm9ybWFsaXplRW50cnk6IChyYXcpID0+IHJhdy50cmltKCkudG9Mb3dlckNhc2UoKSxcbiAgICAgIH07XG4gICAgfSxcbiAgfSxcblxuICB0aHJlYWRpbmc6IHtcbiAgICByZXNvbHZlUmVwbHlUb01vZGU6ICgpID0+IFwib2ZmXCIsXG4gICAgYnVpbGRUb29sQ29udGV4dDogKHsgY29udGV4dCwgaGFzUmVwbGllZFJlZiB9KSA9PiAoe1xuICAgICAgY3VycmVudENoYW5uZWxJZDogY29udGV4dC5Ubz8udHJpbSgpIHx8IHVuZGVmaW5lZCxcbiAgICAgIGN1cnJlbnRUaHJlYWRUczogY29udGV4dC5NZXNzYWdlVGhyZWFkSWQgIT0gbnVsbFxuICAgICAgICA/IFN0cmluZyhjb250ZXh0Lk1lc3NhZ2VUaHJlYWRJZClcbiAgICAgICAgOiBjb250ZXh0LlJlcGx5VG9JZCxcbiAgICAgIGhhc1JlcGxpZWRSZWYsXG4gICAgfSksXG4gIH0sXG5cbiAgbWVzc2FnaW5nOiB7XG4gICAgbm9ybWFsaXplVGFyZ2V0OiAocmF3OiBzdHJpbmcpID0+IHtcbiAgICAgIGxldCBub3JtYWxpemVkID0gcmF3LnRyaW0oKTtcbiAgICAgIGlmICghbm9ybWFsaXplZCkgcmV0dXJuIHVuZGVmaW5lZDtcbiAgICAgIGlmIChub3JtYWxpemVkLnRvTG93ZXJDYXNlKCkuc3RhcnRzV2l0aChcIndlYmV4OlwiKSkge1xuICAgICAgICBub3JtYWxpemVkID0gbm9ybWFsaXplZC5zbGljZShcIndlYmV4OlwiLmxlbmd0aCkudHJpbSgpO1xuICAgICAgfVxuICAgICAgcmV0dXJuIG5vcm1hbGl6ZWQgfHwgdW5kZWZpbmVkO1xuICAgIH0sXG4gICAgdGFyZ2V0UmVzb2x2ZXI6IHtcbiAgICAgIGxvb2tzTGlrZUlkOiAocmF3KSA9PiB7XG4gICAgICAgIGNvbnN0IHRyaW1tZWQgPSByYXcudHJpbSgpO1xuICAgICAgICBpZiAoIXRyaW1tZWQpIHJldHVybiBmYWxzZTtcbiAgICAgICAgLy8gV2ViZXggSURzIGFyZSBiYXNlNjQtZW5jb2RlZCBhbmQgc3RhcnQgd2l0aCBhIHNwZWNpZmljIHByZWZpeFxuICAgICAgICBpZiAodHJpbW1lZC5zdGFydHNXaXRoKFwiWTJselkyOXpjR0Z5YXpvdkwzXCIpKSByZXR1cm4gdHJ1ZTtcbiAgICAgICAgLy8gQWxzbyBhY2NlcHQgZW1haWxzXG4gICAgICAgIHJldHVybiB0cmltbWVkLmluY2x1ZGVzKFwiQFwiKTtcbiAgICAgIH0sXG4gICAgICBoaW50OiBcIjxyb29tSWR8cGVyc29uSWR8ZW1haWw+XCIsXG4gICAgfSxcbiAgfSxcblxuICBvdXRib3VuZDoge1xuICAgIGRlbGl2ZXJ5TW9kZTogXCJkaXJlY3RcIixcbiAgICB0ZXh0Q2h1bmtMaW1pdDogNzAwMCwgLy8gV2ViZXggaGFzIGEgNzQzOSBieXRlIGxpbWl0XG5cbiAgICBzZW5kVGV4dDogYXN5bmMgKHsgdG8sIHRleHQsIGFjY291bnQsIHJlcGx5VG9JZCB9KSA9PiB7XG4gICAgICBjb25zdCBzZW5kZXIgPSBuZXcgV2ViZXhTZW5kZXIoYWNjb3VudC5jb25maWcpO1xuXG4gICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBzZW5kZXIuc2VuZCh7XG4gICAgICAgIHRvLFxuICAgICAgICBjb250ZW50OiB7IHRleHQgfSxcbiAgICAgICAgcGFyZW50SWQ6IHJlcGx5VG9JZCxcbiAgICAgIH0pO1xuXG4gICAgICByZXR1cm4ge1xuICAgICAgICBjaGFubmVsOiBcIndlYmV4XCIsXG4gICAgICAgIG1lc3NhZ2VJZDogcmVzdWx0LmlkLFxuICAgICAgICByb29tSWQ6IHJlc3VsdC5yb29tSWQsXG4gICAgICB9O1xuICAgIH0sXG5cbiAgICBzZW5kTWVkaWE6IGFzeW5jICh7IHRvLCB0ZXh0LCBtZWRpYVVybCwgYWNjb3VudCwgcmVwbHlUb0lkIH0pID0+IHtcbiAgICAgIGNvbnN0IHNlbmRlciA9IG5ldyBXZWJleFNlbmRlcihhY2NvdW50LmNvbmZpZyk7XG5cbiAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHNlbmRlci5zZW5kKHtcbiAgICAgICAgdG8sXG4gICAgICAgIGNvbnRlbnQ6IHtcbiAgICAgICAgICB0ZXh0LFxuICAgICAgICAgIGZpbGVzOiBtZWRpYVVybCA/IFttZWRpYVVybF0gOiB1bmRlZmluZWQsXG4gICAgICAgIH0sXG4gICAgICAgIHBhcmVudElkOiByZXBseVRvSWQsXG4gICAgICB9KTtcblxuICAgICAgcmV0dXJuIHtcbiAgICAgICAgY2hhbm5lbDogXCJ3ZWJleFwiLFxuICAgICAgICBtZXNzYWdlSWQ6IHJlc3VsdC5pZCxcbiAgICAgICAgcm9vbUlkOiByZXN1bHQucm9vbUlkLFxuICAgICAgfTtcbiAgICB9LFxuICB9LFxuXG4gIHN0YXR1czoge1xuICAgIGRlZmF1bHRSdW50aW1lOiB7XG4gICAgICBhY2NvdW50SWQ6IERFRkFVTFRfQUNDT1VOVF9JRCxcbiAgICAgIHJ1bm5pbmc6IGZhbHNlLFxuICAgICAgbGFzdFN0YXJ0QXQ6IG51bGwsXG4gICAgICBsYXN0U3RvcEF0OiBudWxsLFxuICAgICAgbGFzdEVycm9yOiBudWxsLFxuICAgIH0sXG5cbiAgICBjb2xsZWN0U3RhdHVzSXNzdWVzOiAoYWNjb3VudHMpID0+XG4gICAgICBhY2NvdW50cy5mbGF0TWFwKChhY2NvdW50KSA9PiB7XG4gICAgICAgIGNvbnN0IGxhc3RFcnJvciA9IHR5cGVvZiBhY2NvdW50Lmxhc3RFcnJvciA9PT0gXCJzdHJpbmdcIiA/IGFjY291bnQubGFzdEVycm9yLnRyaW0oKSA6IFwiXCI7XG4gICAgICAgIGlmICghbGFzdEVycm9yKSByZXR1cm4gW107XG4gICAgICAgIHJldHVybiBbXG4gICAgICAgICAge1xuICAgICAgICAgICAgY2hhbm5lbDogXCJ3ZWJleFwiLFxuICAgICAgICAgICAgYWNjb3VudElkOiBhY2NvdW50LmFjY291bnRJZCxcbiAgICAgICAgICAgIGtpbmQ6IFwicnVudGltZVwiIGFzIGNvbnN0LFxuICAgICAgICAgICAgbWVzc2FnZTogYENoYW5uZWwgZXJyb3I6ICR7bGFzdEVycm9yfWAsXG4gICAgICAgICAgfSxcbiAgICAgICAgXTtcbiAgICAgIH0pLFxuXG4gICAgYnVpbGRDaGFubmVsU3VtbWFyeTogKHsgc25hcHNob3QgfSkgPT4gKHtcbiAgICAgIGNvbmZpZ3VyZWQ6IChzbmFwc2hvdC5jb25maWd1cmVkID8/IGZhbHNlKSBhcyBib29sZWFuLFxuICAgICAgYmFzZVVybDogKHNuYXBzaG90LmJhc2VVcmwgPz8gbnVsbCkgYXMgc3RyaW5nIHwgbnVsbCxcbiAgICAgIHJ1bm5pbmc6IChzbmFwc2hvdC5ydW5uaW5nID8/IGZhbHNlKSBhcyBib29sZWFuLFxuICAgICAgbGFzdFN0YXJ0QXQ6IChzbmFwc2hvdC5sYXN0U3RhcnRBdCA/PyBudWxsKSBhcyBEYXRlIHwgbnVsbCxcbiAgICAgIGxhc3RTdG9wQXQ6IChzbmFwc2hvdC5sYXN0U3RvcEF0ID8/IG51bGwpIGFzIERhdGUgfCBudWxsLFxuICAgICAgbGFzdEVycm9yOiAoc25hcHNob3QubGFzdEVycm9yID8/IG51bGwpIGFzIHN0cmluZyB8IG51bGwsXG4gICAgfSksXG5cbiAgICBwcm9iZUFjY291bnQ6IGFzeW5jICh7IGFjY291bnQsIHRpbWVvdXRNcyB9KSA9PiB7XG4gICAgICBpZiAoIWFjY291bnQuY29uZmlndXJlZCkge1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgIG9rOiBmYWxzZSxcbiAgICAgICAgICBlcnJvcjogXCJBY2NvdW50IG5vdCBjb25maWd1cmVkXCIsXG4gICAgICAgICAgZWxhcHNlZE1zOiAwLFxuICAgICAgICB9O1xuICAgICAgfVxuXG4gICAgICBjb25zdCBzdGFydCA9IERhdGUubm93KCk7XG4gICAgICB0cnkge1xuICAgICAgICBjb25zdCByZXNwb25zZSA9IGF3YWl0IGZldGNoKFxuICAgICAgICAgIGAke2FjY291bnQuY29uZmlnLmFwaUJhc2VVcmwgPz8gXCJodHRwczovL3dlYmV4YXBpcy5jb20vdjFcIn0vcGVvcGxlL21lYCxcbiAgICAgICAgICB7XG4gICAgICAgICAgICBtZXRob2Q6IFwiR0VUXCIsXG4gICAgICAgICAgICBoZWFkZXJzOiB7XG4gICAgICAgICAgICAgIEF1dGhvcml6YXRpb246IGBCZWFyZXIgJHthY2NvdW50LmNvbmZpZy50b2tlbn1gLFxuICAgICAgICAgICAgICBcIkNvbnRlbnQtVHlwZVwiOiBcImFwcGxpY2F0aW9uL2pzb25cIixcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgICBzaWduYWw6IHRpbWVvdXRNcyA/IEFib3J0U2lnbmFsLnRpbWVvdXQodGltZW91dE1zKSA6IHVuZGVmaW5lZCxcbiAgICAgICAgICB9XG4gICAgICAgICk7XG5cbiAgICAgICAgY29uc3QgZWxhcHNlZE1zID0gRGF0ZS5ub3coKSAtIHN0YXJ0O1xuXG4gICAgICAgIGlmICghcmVzcG9uc2Uub2spIHtcbiAgICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgb2s6IGZhbHNlLFxuICAgICAgICAgICAgZXJyb3I6IGBIVFRQICR7cmVzcG9uc2Uuc3RhdHVzfTogJHtyZXNwb25zZS5zdGF0dXNUZXh0fWAsXG4gICAgICAgICAgICBlbGFwc2VkTXMsXG4gICAgICAgICAgfTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB7IG9rOiB0cnVlLCBlbGFwc2VkTXMgfTtcbiAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgIG9rOiBmYWxzZSxcbiAgICAgICAgICBlcnJvcjogZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpLFxuICAgICAgICAgIGVsYXBzZWRNczogRGF0ZS5ub3coKSAtIHN0YXJ0LFxuICAgICAgICB9O1xuICAgICAgfVxuICAgIH0sXG5cbiAgICBidWlsZEFjY291bnRTbmFwc2hvdDogKHsgYWNjb3VudCwgcnVudGltZSwgcHJvYmUgfSkgPT4gKHtcbiAgICAgIGFjY291bnRJZDogYWNjb3VudC5hY2NvdW50SWQsXG4gICAgICBuYW1lOiBhY2NvdW50Lm5hbWUsXG4gICAgICBlbmFibGVkOiBhY2NvdW50LmVuYWJsZWQsXG4gICAgICBjb25maWd1cmVkOiBhY2NvdW50LmNvbmZpZ3VyZWQsXG4gICAgICBiYXNlVXJsOiBhY2NvdW50LmNvbmZpZy5hcGlCYXNlVXJsID8/IFwiaHR0cHM6Ly93ZWJleGFwaXMuY29tL3YxXCIsXG4gICAgICBydW5uaW5nOiBydW50aW1lPy5ydW5uaW5nID8/IGZhbHNlLFxuICAgICAgbGFzdFN0YXJ0QXQ6IHJ1bnRpbWU/Lmxhc3RTdGFydEF0ID8/IG51bGwsXG4gICAgICBsYXN0U3RvcEF0OiBydW50aW1lPy5sYXN0U3RvcEF0ID8/IG51bGwsXG4gICAgICBsYXN0RXJyb3I6IHJ1bnRpbWU/Lmxhc3RFcnJvciA/PyBudWxsLFxuICAgICAgcHJvYmUsXG4gICAgICBsYXN0UHJvYmVBdDogcnVudGltZT8ubGFzdFByb2JlQXQgPz8gbnVsbCxcbiAgICB9KSxcbiAgfSxcblxuICBnYXRld2F5OiB7XG4gICAgc3RhcnRBY2NvdW50OiBhc3luYyAoY3R4KSA9PiB7XG4gICAgICBjb25zdCB7IGFjY291bnQsIHJ1bnRpbWUsIGxvZywgc2V0U3RhdHVzIH0gPSBjdHg7XG5cbiAgICAgIHNldFN0YXR1cyh7XG4gICAgICAgIGFjY291bnRJZDogYWNjb3VudC5hY2NvdW50SWQsXG4gICAgICAgIGJhc2VVcmw6IGFjY291bnQuY29uZmlnLmFwaUJhc2VVcmwgPz8gXCJodHRwczovL3dlYmV4YXBpcy5jb20vdjFcIixcbiAgICAgIH0pO1xuXG4gICAgICBsb2c/LmluZm8/LihcbiAgICAgICAgYFske2FjY291bnQuYWNjb3VudElkfV0gc3RhcnRpbmcgV2ViZXggcHJvdmlkZXIgKHdlYmhvb2sgbW9kZSlgXG4gICAgICApO1xuXG4gICAgICAvLyBJbml0aWFsaXplIHdlYmhvb2sgaGFuZGxlclxuICAgICAgY29uc3Qgd2ViaG9va0hhbmRsZXIgPSBuZXcgV2ViZXhXZWJob29rSGFuZGxlcihhY2NvdW50LmNvbmZpZyk7XG4gICAgICBhd2FpdCB3ZWJob29rSGFuZGxlci5pbml0aWFsaXplKCk7XG5cbiAgICAgIC8vIFJlZ2lzdGVyIHdlYmhvb2tzIHdpdGggV2ViZXhcbiAgICAgIHRyeSB7XG4gICAgICAgIGF3YWl0IHdlYmhvb2tIYW5kbGVyLnJlZ2lzdGVyV2ViaG9va3MoKTtcbiAgICAgICAgbG9nPy5pbmZvPy4oYFske2FjY291bnQuYWNjb3VudElkfV0gd2ViaG9va3MgcmVnaXN0ZXJlZGApO1xuICAgICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgIGxvZz8ud2Fybj8uKFxuICAgICAgICAgIGBbJHthY2NvdW50LmFjY291bnRJZH1dIGZhaWxlZCB0byByZWdpc3RlciB3ZWJob29rczogJHtlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogZXJyfWBcbiAgICAgICAgKTtcbiAgICAgIH1cblxuICAgICAgLy8gUmVnaXN0ZXIgd2ViaG9vayB0YXJnZXQgZm9yIEhUVFAgaGFuZGxlclxuICAgICAgY29uc3Qgd2ViaG9va1BhdGggPSBgL3dlYmhvb2tzL3dlYmV4LyR7YWNjb3VudC5hY2NvdW50SWR9YDtcblxuICAgICAgY29uc3QgdW5yZWdpc3RlciA9IHJlZ2lzdGVyV2ViZXhXZWJob29rVGFyZ2V0KHdlYmhvb2tQYXRoLCB7XG4gICAgICAgIGFjY291bnQsXG4gICAgICAgIGNvbmZpZzogYWNjb3VudC5jb25maWcsXG4gICAgICAgIHdlYmhvb2tIYW5kbGVyLFxuICAgICAgfSk7XG5cbiAgICAgIGxvZz8uaW5mbz8uKFxuICAgICAgICBgWyR7YWNjb3VudC5hY2NvdW50SWR9XSBIVFRQIHdlYmhvb2sgaGFuZGxlciByZWdpc3RlcmVkIGF0ICR7d2ViaG9va1BhdGh9YFxuICAgICAgKTtcblxuICAgICAgLy8gUmV0dXJuIGNsZWFudXAgZnVuY3Rpb25cbiAgICAgIHJldHVybiBhc3luYyAoKSA9PiB7XG4gICAgICAgIGxvZz8uaW5mbz8uKGBbJHthY2NvdW50LmFjY291bnRJZH1dIHN0b3BwaW5nIFdlYmV4IHByb3ZpZGVyYCk7XG4gICAgICAgIHVucmVnaXN0ZXIoKTtcbiAgICAgIH07XG4gICAgfSxcbiAgfSxcbn07XG4iXX0=
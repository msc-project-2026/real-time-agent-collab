"use strict";
/**
 * Webex Webhook Handler Module
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.WebhookValidationError = exports.WebexWebhookHandler = void 0;
const crypto = __importStar(require("crypto"));
const node_fetch_1 = __importDefault(require("node-fetch"));
const DEFAULT_API_BASE_URL = 'https://webexapis.com/v1';
class WebexWebhookHandler {
    config;
    apiBaseUrl;
    botId = null;
    constructor(config) {
        this.config = config;
        this.apiBaseUrl = config.apiBaseUrl || DEFAULT_API_BASE_URL;
    }
    /**
     * Initialize the webhook handler (fetch bot info)
     */
    async initialize() {
        const botInfo = await this.getBotInfo();
        this.botId = botInfo.id;
    }
    /**
     * Handle an incoming webhook request
     */
    async handleWebhook(payload, signature) {
        // Verify webhook signature if secret is configured
        if (this.config.webhookSecret && signature) {
            if (!this.verifySignature(payload, signature)) {
                throw new WebhookValidationError('Invalid webhook signature');
            }
        }
        // Only handle message created events
        if (payload.resource !== 'messages' || payload.event !== 'created') {
            return null;
        }
        // Ignore messages from the bot itself
        if (payload.data.personId === this.botId) {
            return null;
        }
        // Check DM policy
        if (payload.data.roomType === 'direct') {
            if (!this.isAllowedSender(payload.data)) {
                return null;
            }
        }
        // Fetch full message details (webhook only contains IDs)
        const message = await this.fetchMessage(payload.data.id);
        // Normalize to OpenClaw envelope
        return this.normalizeMessage(message);
    }
    /**
     * Verify webhook signature using HMAC-SHA1
     */
    verifySignature(payload, signature) {
        if (!this.config.webhookSecret) {
            return true;
        }
        const hmac = crypto.createHmac('sha1', this.config.webhookSecret);
        hmac.update(JSON.stringify(payload));
        const expectedSignature = hmac.digest('hex');
        return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature));
    }
    /**
     * Check if the sender is allowed based on DM policy
     */
    isAllowedSender(data) {
        switch (this.config.dmPolicy) {
            case 'allow':
                return true;
            case 'deny':
                return false;
            case 'allowlisted':
                if (!this.config.allowFrom || this.config.allowFrom.length === 0) {
                    return false;
                }
                return this.config.allowFrom.includes(data.personId) ||
                    this.config.allowFrom.includes(data.personEmail);
            default:
                return false;
        }
    }
    /**
     * Fetch full message details from Webex API
     */
    async fetchMessage(messageId) {
        const response = await (0, node_fetch_1.default)(`${this.apiBaseUrl}/messages/${messageId}`, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${this.config.token}`,
                'Content-Type': 'application/json',
            },
        });
        if (!response.ok) {
            throw new Error(`Failed to fetch message: ${response.status} ${response.statusText}`);
        }
        return response.json();
    }
    /**
     * Normalize a Webex message to OpenClaw envelope format
     */
    normalizeMessage(message) {
        const attachments = [];
        // Convert file attachments
        if (message.files && message.files.length > 0) {
            for (const fileUrl of message.files) {
                attachments.push({
                    type: 'file',
                    url: fileUrl,
                });
            }
        }
        // Convert card attachments
        if (message.attachments && message.attachments.length > 0) {
            for (const attachment of message.attachments) {
                attachments.push({
                    type: 'card',
                    content: attachment.content,
                });
            }
        }
        return {
            id: message.id,
            channel: 'webex',
            conversationId: message.roomId,
            author: {
                id: message.personId,
                email: message.personEmail,
                displayName: undefined, // Would need additional API call to get
                isBot: false, // Messages from bot are filtered out earlier
            },
            content: {
                text: message.text,
                markdown: message.markdown,
                attachments: attachments.length > 0 ? attachments : undefined,
            },
            metadata: {
                roomType: message.roomType,
                roomId: message.roomId,
                timestamp: message.created,
                mentions: message.mentionedPeople,
                parentId: message.parentId,
                raw: message,
            },
        };
    }
    /**
     * Register webhooks with Webex
     */
    async registerWebhooks() {
        // First, list existing webhooks and remove duplicates
        const existing = await this.listWebhooks();
        const targetUrl = this.config.webhookUrl;
        // Delete existing webhooks with the same target URL
        for (const webhook of existing) {
            if (webhook.targetUrl === targetUrl) {
                await this.deleteWebhook(webhook.id);
            }
        }
        // Create new webhooks for messages
        const webhooks = [];
        // Webhook for new messages
        const messageCreatedWebhook = await this.createWebhook({
            name: 'OpenClaw Message Handler',
            targetUrl,
            resource: 'messages',
            event: 'created',
            secret: this.config.webhookSecret,
        });
        webhooks.push(messageCreatedWebhook);
        return webhooks;
    }
    /**
     * List all webhooks
     */
    async listWebhooks() {
        const response = await (0, node_fetch_1.default)(`${this.apiBaseUrl}/webhooks`, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${this.config.token}`,
                'Content-Type': 'application/json',
            },
        });
        if (!response.ok) {
            throw new Error(`Failed to list webhooks: ${response.status} ${response.statusText}`);
        }
        const data = await response.json();
        return data.items;
    }
    /**
     * Create a webhook
     */
    async createWebhook(request) {
        const response = await (0, node_fetch_1.default)(`${this.apiBaseUrl}/webhooks`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${this.config.token}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(request),
        });
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Failed to create webhook: ${response.status} ${response.statusText} - ${errorText}`);
        }
        return response.json();
    }
    /**
     * Delete a webhook
     */
    async deleteWebhook(webhookId) {
        const response = await (0, node_fetch_1.default)(`${this.apiBaseUrl}/webhooks/${webhookId}`, {
            method: 'DELETE',
            headers: {
                'Authorization': `Bearer ${this.config.token}`,
            },
        });
        if (!response.ok && response.status !== 404) {
            throw new Error(`Failed to delete webhook: ${response.status} ${response.statusText}`);
        }
    }
    /**
     * Get bot information
     */
    async getBotInfo() {
        const response = await (0, node_fetch_1.default)(`${this.apiBaseUrl}/people/me`, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${this.config.token}`,
                'Content-Type': 'application/json',
            },
        });
        if (!response.ok) {
            throw new Error(`Failed to get bot info: ${response.status} ${response.statusText}`);
        }
        return response.json();
    }
    /**
     * Get the bot ID (after initialization)
     */
    getBotId() {
        return this.botId;
    }
}
exports.WebexWebhookHandler = WebexWebhookHandler;
/**
 * Custom error for webhook validation failures
 */
class WebhookValidationError extends Error {
    constructor(message) {
        super(message);
        this.name = 'WebhookValidationError';
        if (Error.captureStackTrace) {
            Error.captureStackTrace(this, WebhookValidationError);
        }
    }
}
exports.WebhookValidationError = WebhookValidationError;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoid2ViaG9vay5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uL3NyYy93ZWJob29rLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7QUFBQTs7R0FFRzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FBRUgsK0NBQWlDO0FBQ2pDLDREQUErQjtBQWEvQixNQUFNLG9CQUFvQixHQUFHLDBCQUEwQixDQUFDO0FBRXhELE1BQWEsbUJBQW1CO0lBQ3RCLE1BQU0sQ0FBcUI7SUFDM0IsVUFBVSxDQUFTO0lBQ25CLEtBQUssR0FBa0IsSUFBSSxDQUFDO0lBRXBDLFlBQVksTUFBMEI7UUFDcEMsSUFBSSxDQUFDLE1BQU0sR0FBRyxNQUFNLENBQUM7UUFDckIsSUFBSSxDQUFDLFVBQVUsR0FBRyxNQUFNLENBQUMsVUFBVSxJQUFJLG9CQUFvQixDQUFDO0lBQzlELENBQUM7SUFFRDs7T0FFRztJQUNILEtBQUssQ0FBQyxVQUFVO1FBQ2QsTUFBTSxPQUFPLEdBQUcsTUFBTSxJQUFJLENBQUMsVUFBVSxFQUFFLENBQUM7UUFDeEMsSUFBSSxDQUFDLEtBQUssR0FBRyxPQUFPLENBQUMsRUFBRSxDQUFDO0lBQzFCLENBQUM7SUFFRDs7T0FFRztJQUNILEtBQUssQ0FBQyxhQUFhLENBQ2pCLE9BQTRCLEVBQzVCLFNBQWtCO1FBRWxCLG1EQUFtRDtRQUNuRCxJQUFJLElBQUksQ0FBQyxNQUFNLENBQUMsYUFBYSxJQUFJLFNBQVMsRUFBRSxDQUFDO1lBQzNDLElBQUksQ0FBQyxJQUFJLENBQUMsZUFBZSxDQUFDLE9BQU8sRUFBRSxTQUFTLENBQUMsRUFBRSxDQUFDO2dCQUM5QyxNQUFNLElBQUksc0JBQXNCLENBQUMsMkJBQTJCLENBQUMsQ0FBQztZQUNoRSxDQUFDO1FBQ0gsQ0FBQztRQUVELHFDQUFxQztRQUNyQyxJQUFJLE9BQU8sQ0FBQyxRQUFRLEtBQUssVUFBVSxJQUFJLE9BQU8sQ0FBQyxLQUFLLEtBQUssU0FBUyxFQUFFLENBQUM7WUFD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MkJBQTJCLFFBQVEsQ0FBQyxNQUFNLElBQUksUUFBUSxDQUFDLFVBQVUsRUFBRSxDQUFDLENBQUM7UUFDdkYsQ0FBQztRQUVELE9BQU8sUUFBUSxDQUFDLElBQUksRUFBb0UsQ0FBQztJQUMzRixDQUFDO0lBRUQ7O09BRUc7SUFDSCxRQUFRO1FBQ04sT0FBTyxJQUFJLENBQUMsS0FBSyxDQUFDO0lBQ3BCLENBQUM7Q0FDRjtBQXRSRCxrREFzUkM7QUFFRDs7R0FFRztBQUNILE1BQWEsc0JBQXVCLFNBQVEsS0FBSztJQUMvQyxZQUFZLE9BQWU7UUFDekIsS0FBSyxDQUFDLE9BQU8sQ0FBQyxDQUFDO1FBQ2YsSUFBSSxDQUFDLElBQUksR0FBRyx3QkFBd0IsQ0FBQztRQUVyQyxJQUFJLEtBQUssQ0FBQyxpQkFBaUIsRUFBRSxDQUFDO1lBQzVCLEtBQUssQ0FBQyxpQkFBaUIsQ0FBQyxJQUFJLEVBQUUsc0JBQXNCLENBQUMsQ0FBQztRQUN4RCxDQUFDO0lBQ0gsQ0FBQztDQUNGO0FBVEQsd0RBU0MiLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIFdlYmV4IFdlYmhvb2sgSGFuZGxlciBNb2R1bGVcbiAqL1xuXG5pbXBvcnQgKiBhcyBjcnlwdG8gZnJvbSAnY3J5cHRvJztcbmltcG9ydCBmZXRjaCBmcm9tICdub2RlLWZldGNoJztcbmltcG9ydCB0eXBlIHtcbiAgV2ViZXhDaGFubmVsQ29uZmlnLFxuICBXZWJleFdlYmhvb2tQYXlsb2FkLFxuICBXZWJleFdlYmhvb2tEYXRhLFxuICBXZWJleE1lc3NhZ2UsXG4gIFdlYmV4V2ViaG9vayxcbiAgQ3JlYXRlV2ViaG9va1JlcXVlc3QsXG4gIE9wZW5DbGF3RW52ZWxvcGUsXG4gIE9wZW5DbGF3QXR0YWNobWVudCxcbiAgUGFnaW5hdGVkUmVzcG9uc2UsXG59IGZyb20gJy4vdHlwZXMnO1xuXG5jb25zdCBERUZBVUxUX0FQSV9CQVNFX1VSTCA9ICdodHRwczovL3dlYmV4YXBpcy5jb20vdjEnO1xuXG5leHBvcnQgY2xhc3MgV2ViZXhXZWJob29rSGFuZGxlciB7XG4gIHByaXZhdGUgY29uZmlnOiBXZWJleENoYW5uZWxDb25maWc7XG4gIHByaXZhdGUgYXBpQmFzZVVybDogc3RyaW5nO1xuICBwcml2YXRlIGJvdElkOiBzdHJpbmcgfCBudWxsID0gbnVsbDtcblxuICBjb25zdHJ1Y3Rvcihjb25maWc6IFdlYmV4Q2hhbm5lbENvbmZpZykge1xuICAgIHRoaXMuY29uZmlnID0gY29uZmlnO1xuICAgIHRoaXMuYXBpQmFzZVVybCA9IGNvbmZpZy5hcGlCYXNlVXJsIHx8IERFRkFVTFRfQVBJX0JBU0VfVVJMO1xuICB9XG5cbiAgLyoqXG4gICAqIEluaXRpYWxpemUgdGhlIHdlYmhvb2sgaGFuZGxlciAoZmV0Y2ggYm90IGluZm8pXG4gICAqL1xuICBhc3luYyBpbml0aWFsaXplKCk6IFByb21pc2U8dm9pZD4ge1xuICAgIGNvbnN0IGJvdEluZm8gPSBhd2FpdCB0aGlzLmdldEJvdEluZm8oKTtcbiAgICB0aGlzLmJvdElkID0gYm90SW5mby5pZDtcbiAgfVxuXG4gIC8qKlxuICAgKiBIYW5kbGUgYW4gaW5jb21pbmcgd2ViaG9vayByZXF1ZXN0XG4gICAqL1xuICBhc3luYyBoYW5kbGVXZWJob29rKFxuICAgIHBheWxvYWQ6IFdlYmV4V2ViaG9va1BheWxvYWQsXG4gICAgc2lnbmF0dXJlPzogc3RyaW5nXG4gICk6IFByb21pc2U8T3BlbkNsYXdFbnZlbG9wZSB8IG51bGw+IHtcbiAgICAvLyBWZXJpZnkgd2ViaG9vayBzaWduYXR1cmUgaWYgc2VjcmV0IGlzIGNvbmZpZ3VyZWRcbiAgICBpZiAodGhpcy5jb25maWcud2ViaG9va1NlY3JldCAmJiBzaWduYXR1cmUpIHtcbiAgICAgIGlmICghdGhpcy52ZXJpZnlTaWduYXR1cmUocGF5bG9hZCwgc2lnbmF0dXJlKSkge1xuICAgICAgICB0aHJvdyBuZXcgV2ViaG9va1ZhbGlkYXRpb25FcnJvcignSW52YWxpZCB3ZWJob29rIHNpZ25hdHVyZScpO1xuICAgICAgfVxuICAgIH1cblxuICAgIC8vIE9ubHkgaGFuZGxlIG1lc3NhZ2UgY3JlYXRlZCBldmVudHNcbiAgICBpZiAocGF5bG9hZC5yZXNvdXJjZSAhPT0gJ21lc3NhZ2VzJyB8fCBwYXlsb2FkLmV2ZW50ICE9PSAnY3JlYXRlZCcpIHtcbiAgICAgIHJldHVybiBudWxsO1xuICAgIH1cblxuICAgIC8vIElnbm9yZSBtZXNzYWdlcyBmcm9tIHRoZSBib3QgaXRzZWxmXG4gICAgaWYgKHBheWxvYWQuZGF0YS5wZXJzb25JZCA9PT0gdGhpcy5ib3RJZCkge1xuICAgICAgcmV0dXJuIG51bGw7XG4gICAgfVxuXG4gICAgLy8gQ2hlY2sgRE0gcG9saWN5XG4gICAgaWYgKHBheWxvYWQuZGF0YS5yb29tVHlwZSA9PT0gJ2RpcmVjdCcpIHtcbiAgICAgIGlmICghdGhpcy5pc0FsbG93ZWRTZW5kZXIocGF5bG9hZC5kYXRhKSkge1xuICAgICAgICByZXR1cm4gbnVsbDtcbiAgICAgIH1cbiAgICB9XG5cbiAgICAvLyBGZXRjaCBmdWxsIG1lc3NhZ2UgZGV0YWlscyAod2ViaG9vayBvbmx5IGNvbnRhaW5zIElEcylcbiAgICBjb25zdCBtZXNzYWdlID0gYXdhaXQgdGhpcy5mZXRjaE1lc3NhZ2UocGF5bG9hZC5kYXRhLmlkKTtcblxuICAgIC8vIE5vcm1hbGl6ZSB0byBPcGVuQ2xhdyBlbnZlbG9wZVxuICAgIHJldHVybiB0aGlzLm5vcm1hbGl6ZU1lc3NhZ2UobWVzc2FnZSk7XG4gIH1cblxuICAvKipcbiAgICogVmVyaWZ5IHdlYmhvb2sgc2lnbmF0dXJlIHVzaW5nIEhNQUMtU0hBMVxuICAgKi9cbiAgdmVyaWZ5U2lnbmF0dXJlKHBheWxvYWQ6IFdlYmV4V2ViaG9va1BheWxvYWQsIHNpZ25hdHVyZTogc3RyaW5nKTogYm9vbGVhbiB7XG4gICAgaWYgKCF0aGlzLmNvbmZpZy53ZWJob29rU2VjcmV0KSB7XG4gICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG5cbiAgICBjb25zdCBobWFjID0gY3J5cHRvLmNyZWF0ZUhtYWMoJ3NoYTEnLCB0aGlzLmNvbmZpZy53ZWJob29rU2VjcmV0KTtcbiAgICBobWFjLnVwZGF0ZShKU09OLnN0cmluZ2lmeShwYXlsb2FkKSk7XG4gICAgY29uc3QgZXhwZWN0ZWRTaWduYXR1cmUgPSBobWFjLmRpZ2VzdCgnaGV4Jyk7XG5cbiAgICByZXR1cm4gY3J5cHRvLnRpbWluZ1NhZmVFcXVhbChcbiAgICAgIEJ1ZmZlci5mcm9tKHNpZ25hdHVyZSksXG4gICAgICBCdWZmZXIuZnJvbShleHBlY3RlZFNpZ25hdHVyZSlcbiAgICApO1xuICB9XG5cbiAgLyoqXG4gICAqIENoZWNrIGlmIHRoZSBzZW5kZXIgaXMgYWxsb3dlZCBiYXNlZCBvbiBETSBwb2xpY3lcbiAgICovXG4gIHByaXZhdGUgaXNBbGxvd2VkU2VuZGVyKGRhdGE6IFdlYmV4V2ViaG9va0RhdGEpOiBib29sZWFuIHtcbiAgICBzd2l0Y2ggKHRoaXMuY29uZmlnLmRtUG9saWN5KSB7XG4gICAgICBjYXNlICdhbGxvdyc6XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgY2FzZSAnZGVueSc6XG4gICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgIGNhc2UgJ2FsbG93bGlzdGVkJzpcbiAgICAgICAgaWYgKCF0aGlzLmNvbmZpZy5hbGxvd0Zyb20gfHwgdGhpcy5jb25maWcuYWxsb3dGcm9tLmxlbmd0aCA9PT0gMCkge1xuICAgICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gdGhpcy5jb25maWcuYWxsb3dGcm9tLmluY2x1ZGVzKGRhdGEucGVyc29uSWQpIHx8XG4gICAgICAgICAgICAgICB0aGlzLmNvbmZpZy5hbGxvd0Zyb20uaW5jbHVkZXMoZGF0YS5wZXJzb25FbWFpbCk7XG4gICAgICBkZWZhdWx0OlxuICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgfVxuICB9XG5cbiAgLyoqXG4gICAqIEZldGNoIGZ1bGwgbWVzc2FnZSBkZXRhaWxzIGZyb20gV2ViZXggQVBJXG4gICAqL1xuICBwcml2YXRlIGFzeW5jIGZldGNoTWVzc2FnZShtZXNzYWdlSWQ6IHN0cmluZyk6IFByb21pc2U8V2ViZXhNZXNzYWdlPiB7XG4gICAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCBmZXRjaChgJHt0aGlzLmFwaUJhc2VVcmx9L21lc3NhZ2VzLyR7bWVzc2FnZUlkfWAsIHtcbiAgICAgIG1ldGhvZDogJ0dFVCcsXG4gICAgICBoZWFkZXJzOiB7XG4gICAgICAgICdBdXRob3JpemF0aW9uJzogYEJlYXJlciAke3RoaXMuY29uZmlnLnRva2VufWAsXG4gICAgICAgICdDb250ZW50LVR5cGUnOiAnYXBwbGljYXRpb24vanNvbicsXG4gICAgICB9LFxuICAgIH0pO1xuXG4gICAgaWYgKCFyZXNwb25zZS5vaykge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKGBGYWlsZWQgdG8gZmV0Y2ggbWVzc2FnZTogJHtyZXNwb25zZS5zdGF0dXN9ICR7cmVzcG9uc2Uuc3RhdHVzVGV4dH1gKTtcbiAgICB9XG5cbiAgICByZXR1cm4gcmVzcG9uc2UuanNvbigpIGFzIFByb21pc2U8V2ViZXhNZXNzYWdlPjtcbiAgfVxuXG4gIC8qKlxuICAgKiBOb3JtYWxpemUgYSBXZWJleCBtZXNzYWdlIHRvIE9wZW5DbGF3IGVudmVsb3BlIGZvcm1hdFxuICAgKi9cbiAgcHJpdmF0ZSBub3JtYWxpemVNZXNzYWdlKG1lc3NhZ2U6IFdlYmV4TWVzc2FnZSk6IE9wZW5DbGF3RW52ZWxvcGUge1xuICAgIGNvbnN0IGF0dGFjaG1lbnRzOiBPcGVuQ2xhd0F0dGFjaG1lbnRbXSA9IFtdO1xuXG4gICAgLy8gQ29udmVydCBmaWxlIGF0dGFjaG1lbnRzXG4gICAgaWYgKG1lc3NhZ2UuZmlsZXMgJiYgbWVzc2FnZS5maWxlcy5sZW5ndGggPiAwKSB7XG4gICAgICBmb3IgKGNvbnN0IGZpbGVVcmwgb2YgbWVzc2FnZS5maWxlcykge1xuICAgICAgICBhdHRhY2htZW50cy5wdXNoKHtcbiAgICAgICAgICB0eXBlOiAnZmlsZScsXG4gICAgICAgICAgdXJsOiBmaWxlVXJsLFxuICAgICAgICB9KTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICAvLyBDb252ZXJ0IGNhcmQgYXR0YWNobWVudHNcbiAgICBpZiAobWVzc2FnZS5hdHRhY2htZW50cyAmJiBtZXNzYWdlLmF0dGFjaG1lbnRzLmxlbmd0aCA+IDApIHtcbiAgICAgIGZvciAoY29uc3QgYXR0YWNobWVudCBvZiBtZXNzYWdlLmF0dGFjaG1lbnRzKSB7XG4gICAgICAgIGF0dGFjaG1lbnRzLnB1c2goe1xuICAgICAgICAgIHR5cGU6ICdjYXJkJyxcbiAgICAgICAgICBjb250ZW50OiBhdHRhY2htZW50LmNvbnRlbnQsXG4gICAgICAgIH0pO1xuICAgICAgfVxuICAgIH1cblxuICAgIHJldHVybiB7XG4gICAgICBpZDogbWVzc2FnZS5pZCxcbiAgICAgIGNoYW5uZWw6ICd3ZWJleCcsXG4gICAgICBjb252ZXJzYXRpb25JZDogbWVzc2FnZS5yb29tSWQsXG4gICAgICBhdXRob3I6IHtcbiAgICAgICAgaWQ6IG1lc3NhZ2UucGVyc29uSWQsXG4gICAgICAgIGVtYWlsOiBtZXNzYWdlLnBlcnNvbkVtYWlsLFxuICAgICAgICBkaXNwbGF5TmFtZTogdW5kZWZpbmVkLCAvLyBXb3VsZCBuZWVkIGFkZGl0aW9uYWwgQVBJIGNhbGwgdG8gZ2V0XG4gICAgICAgIGlzQm90OiBmYWxzZSwgLy8gTWVzc2FnZXMgZnJvbSBib3QgYXJlIGZpbHRlcmVkIG91dCBlYXJsaWVyXG4gICAgICB9LFxuICAgICAgY29udGVudDoge1xuICAgICAgICB0ZXh0OiBtZXNzYWdlLnRleHQsXG4gICAgICAgIG1hcmtkb3duOiBtZXNzYWdlLm1hcmtkb3duLFxuICAgICAgICBhdHRhY2htZW50czogYXR0YWNobWVudHMubGVuZ3RoID4gMCA/IGF0dGFjaG1lbnRzIDogdW5kZWZpbmVkLFxuICAgICAgfSxcbiAgICAgIG1ldGFkYXRhOiB7XG4gICAgICAgIHJvb21UeXBlOiBtZXNzYWdlLnJvb21UeXBlLFxuICAgICAgICByb29tSWQ6IG1lc3NhZ2Uucm9vbUlkLFxuICAgICAgICB0aW1lc3RhbXA6IG1lc3NhZ2UuY3JlYXRlZCxcbiAgICAgICAgbWVudGlvbnM6IG1lc3NhZ2UubWVudGlvbmVkUGVvcGxlLFxuICAgICAgICBwYXJlbnRJZDogbWVzc2FnZS5wYXJlbnRJZCxcbiAgICAgICAgcmF3OiBtZXNzYWdlLFxuICAgICAgfSxcbiAgICB9O1xuICB9XG5cbiAgLyoqXG4gICAqIFJlZ2lzdGVyIHdlYmhvb2tzIHdpdGggV2ViZXhcbiAgICovXG4gIGFzeW5jIHJlZ2lzdGVyV2ViaG9va3MoKTogUHJvbWlzZTxXZWJleFdlYmhvb2tbXT4ge1xuICAgIC8vIEZpcnN0LCBsaXN0IGV4aXN0aW5nIHdlYmhvb2tzIGFuZCByZW1vdmUgZHVwbGljYXRlc1xuICAgIGNvbnN0IGV4aXN0aW5nID0gYXdhaXQgdGhpcy5saXN0V2ViaG9va3MoKTtcbiAgICBjb25zdCB0YXJnZXRVcmwgPSB0aGlzLmNvbmZpZy53ZWJob29rVXJsO1xuXG4gICAgLy8gRGVsZXRlIGV4aXN0aW5nIHdlYmhvb2tzIHdpdGggdGhlIHNhbWUgdGFyZ2V0IFVSTFxuICAgIGZvciAoY29uc3Qgd2ViaG9vayBvZiBleGlzdGluZykge1xuICAgICAgaWYgKHdlYmhvb2sudGFyZ2V0VXJsID09PSB0YXJnZXRVcmwpIHtcbiAgICAgICAgYXdhaXQgdGhpcy5kZWxldGVXZWJob29rKHdlYmhvb2suaWQpO1xuICAgICAgfVxuICAgIH1cblxuICAgIC8vIENyZWF0ZSBuZXcgd2ViaG9va3MgZm9yIG1lc3NhZ2VzXG4gICAgY29uc3Qgd2ViaG9va3M6IFdlYmV4V2ViaG9va1tdID0gW107XG5cbiAgICAvLyBXZWJob29rIGZvciBuZXcgbWVzc2FnZXNcbiAgICBjb25zdCBtZXNzYWdlQ3JlYXRlZFdlYmhvb2sgPSBhd2FpdCB0aGlzLmNyZWF0ZVdlYmhvb2soe1xuICAgICAgbmFtZTogJ09wZW5DbGF3IE1lc3NhZ2UgSGFuZGxlcicsXG4gICAgICB0YXJnZXRVcmwsXG4gICAgICByZXNvdXJjZTogJ21lc3NhZ2VzJyxcbiAgICAgIGV2ZW50OiAnY3JlYXRlZCcsXG4gICAgICBzZWNyZXQ6IHRoaXMuY29uZmlnLndlYmhvb2tTZWNyZXQsXG4gICAgfSk7XG4gICAgd2ViaG9va3MucHVzaChtZXNzYWdlQ3JlYXRlZFdlYmhvb2spO1xuXG4gICAgcmV0dXJuIHdlYmhvb2tzO1xuICB9XG5cbiAgLyoqXG4gICAqIExpc3QgYWxsIHdlYmhvb2tzXG4gICAqL1xuICBhc3luYyBsaXN0V2ViaG9va3MoKTogUHJvbWlzZTxXZWJleFdlYmhvb2tbXT4ge1xuICAgIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgZmV0Y2goYCR7dGhpcy5hcGlCYXNlVXJsfS93ZWJob29rc2AsIHtcbiAgICAgIG1ldGhvZDogJ0dFVCcsXG4gICAgICBoZWFkZXJzOiB7XG4gICAgICAgICdBdXRob3JpemF0aW9uJzogYEJlYXJlciAke3RoaXMuY29uZmlnLnRva2VufWAsXG4gICAgICAgICdDb250ZW50LVR5cGUnOiAnYXBwbGljYXRpb24vanNvbicsXG4gICAgICB9LFxuICAgIH0pO1xuXG4gICAgaWYgKCFyZXNwb25zZS5vaykge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKGBGYWlsZWQgdG8gbGlzdCB3ZWJob29rczogJHtyZXNwb25zZS5zdGF0dXN9ICR7cmVzcG9uc2Uuc3RhdHVzVGV4dH1gKTtcbiAgICB9XG5cbiAgICBjb25zdCBkYXRhID0gYXdhaXQgcmVzcG9uc2UuanNvbigpIGFzIFBhZ2luYXRlZFJlc3BvbnNlPFdlYmV4V2ViaG9vaz47XG4gICAgcmV0dXJuIGRhdGEuaXRlbXM7XG4gIH1cblxuICAvKipcbiAgICogQ3JlYXRlIGEgd2ViaG9va1xuICAgKi9cbiAgYXN5bmMgY3JlYXRlV2ViaG9vayhyZXF1ZXN0OiBDcmVhdGVXZWJob29rUmVxdWVzdCk6IFByb21pc2U8V2ViZXhXZWJob29rPiB7XG4gICAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCBmZXRjaChgJHt0aGlzLmFwaUJhc2VVcmx9L3dlYmhvb2tzYCwge1xuICAgICAgbWV0aG9kOiAnUE9TVCcsXG4gICAgICBoZWFkZXJzOiB7XG4gICAgICAgICdBdXRob3JpemF0aW9uJzogYEJlYXJlciAke3RoaXMuY29uZmlnLnRva2VufWAsXG4gICAgICAgICdDb250ZW50LVR5cGUnOiAnYXBwbGljYXRpb24vanNvbicsXG4gICAgICB9LFxuICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkocmVxdWVzdCksXG4gICAgfSk7XG5cbiAgICBpZiAoIXJlc3BvbnNlLm9rKSB7XG4gICAgICBjb25zdCBlcnJvclRleHQgPSBhd2FpdCByZXNwb25zZS50ZXh0KCk7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYEZhaWxlZCB0byBjcmVhdGUgd2ViaG9vazogJHtyZXNwb25zZS5zdGF0dXN9ICR7cmVzcG9uc2Uuc3RhdHVzVGV4dH0gLSAke2Vycm9yVGV4dH1gKTtcbiAgICB9XG5cbiAgICByZXR1cm4gcmVzcG9uc2UuanNvbigpIGFzIFByb21pc2U8V2ViZXhXZWJob29rPjtcbiAgfVxuXG4gIC8qKlxuICAgKiBEZWxldGUgYSB3ZWJob29rXG4gICAqL1xuICBhc3luYyBkZWxldGVXZWJob29rKHdlYmhvb2tJZDogc3RyaW5nKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCBmZXRjaChgJHt0aGlzLmFwaUJhc2VVcmx9L3dlYmhvb2tzLyR7d2ViaG9va0lkfWAsIHtcbiAgICAgIG1ldGhvZDogJ0RFTEVURScsXG4gICAgICBoZWFkZXJzOiB7XG4gICAgICAgICdBdXRob3JpemF0aW9uJzogYEJlYXJlciAke3RoaXMuY29uZmlnLnRva2VufWAsXG4gICAgICB9LFxuICAgIH0pO1xuXG4gICAgaWYgKCFyZXNwb25zZS5vayAmJiByZXNwb25zZS5zdGF0dXMgIT09IDQwNCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKGBGYWlsZWQgdG8gZGVsZXRlIHdlYmhvb2s6ICR7cmVzcG9uc2Uuc3RhdHVzfSAke3Jlc3BvbnNlLnN0YXR1c1RleHR9YCk7XG4gICAgfVxuICB9XG5cbiAgLyoqXG4gICAqIEdldCBib3QgaW5mb3JtYXRpb25cbiAgICovXG4gIHByaXZhdGUgYXN5bmMgZ2V0Qm90SW5mbygpOiBQcm9taXNlPHsgaWQ6IHN0cmluZzsgZGlzcGxheU5hbWU6IHN0cmluZzsgZW1haWxzOiBzdHJpbmdbXSB9PiB7XG4gICAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCBmZXRjaChgJHt0aGlzLmFwaUJhc2VVcmx9L3Blb3BsZS9tZWAsIHtcbiAgICAgIG1ldGhvZDogJ0dFVCcsXG4gICAgICBoZWFkZXJzOiB7XG4gICAgICAgICdBdXRob3JpemF0aW9uJzogYEJlYXJlciAke3RoaXMuY29uZmlnLnRva2VufWAsXG4gICAgICAgICdDb250ZW50LVR5cGUnOiAnYXBwbGljYXRpb24vanNvbicsXG4gICAgICB9LFxuICAgIH0pO1xuXG4gICAgaWYgKCFyZXNwb25zZS5vaykge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKGBGYWlsZWQgdG8gZ2V0IGJvdCBpbmZvOiAke3Jlc3BvbnNlLnN0YXR1c30gJHtyZXNwb25zZS5zdGF0dXNUZXh0fWApO1xuICAgIH1cblxuICAgIHJldHVybiByZXNwb25zZS5qc29uKCkgYXMgUHJvbWlzZTx7IGlkOiBzdHJpbmc7IGRpc3BsYXlOYW1lOiBzdHJpbmc7IGVtYWlsczogc3RyaW5nW10gfT47XG4gIH1cblxuICAvKipcbiAgICogR2V0IHRoZSBib3QgSUQgKGFmdGVyIGluaXRpYWxpemF0aW9uKVxuICAgKi9cbiAgZ2V0Qm90SWQoKTogc3RyaW5nIHwgbnVsbCB7XG4gICAgcmV0dXJuIHRoaXMuYm90SWQ7XG4gIH1cbn1cblxuLyoqXG4gKiBDdXN0b20gZXJyb3IgZm9yIHdlYmhvb2sgdmFsaWRhdGlvbiBmYWlsdXJlc1xuICovXG5leHBvcnQgY2xhc3MgV2ViaG9va1ZhbGlkYXRpb25FcnJvciBleHRlbmRzIEVycm9yIHtcbiAgY29uc3RydWN0b3IobWVzc2FnZTogc3RyaW5nKSB7XG4gICAgc3VwZXIobWVzc2FnZSk7XG4gICAgdGhpcy5uYW1lID0gJ1dlYmhvb2tWYWxpZGF0aW9uRXJyb3InO1xuXG4gICAgaWYgKEVycm9yLmNhcHR1cmVTdGFja1RyYWNlKSB7XG4gICAgICBFcnJvci5jYXB0dXJlU3RhY2tUcmFjZSh0aGlzLCBXZWJob29rVmFsaWRhdGlvbkVycm9yKTtcbiAgICB9XG4gIH1cbn1cbiJdfQ==
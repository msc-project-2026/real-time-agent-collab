/**
 * Webex Webhook Handler Module
 */
import type { WebexChannelConfig, WebexWebhookPayload, WebexWebhook, CreateWebhookRequest, OpenClawEnvelope } from './types';
export declare class WebexWebhookHandler {
    private config;
    private apiBaseUrl;
    private botId;
    constructor(config: WebexChannelConfig);
    /**
     * Initialize the webhook handler (fetch bot info)
     */
    initialize(): Promise<void>;
    /**
     * Handle an incoming webhook request
     */
    handleWebhook(payload: WebexWebhookPayload, signature?: string): Promise<OpenClawEnvelope | null>;
    /**
     * Verify webhook signature using HMAC-SHA1
     */
    verifySignature(payload: WebexWebhookPayload, signature: string): boolean;
    /**
     * Check if the sender is allowed based on DM policy
     */
    private isAllowedSender;
    /**
     * Fetch full message details from Webex API
     */
    private fetchMessage;
    /**
     * Normalize a Webex message to OpenClaw envelope format
     */
    private normalizeMessage;
    /**
     * Register webhooks with Webex
     */
    registerWebhooks(): Promise<WebexWebhook[]>;
    /**
     * List all webhooks
     */
    listWebhooks(): Promise<WebexWebhook[]>;
    /**
     * Create a webhook
     */
    createWebhook(request: CreateWebhookRequest): Promise<WebexWebhook>;
    /**
     * Delete a webhook
     */
    deleteWebhook(webhookId: string): Promise<void>;
    /**
     * Get bot information
     */
    private getBotInfo;
    /**
     * Get the bot ID (after initialization)
     */
    getBotId(): string | null;
}
/**
 * Custom error for webhook validation failures
 */
export declare class WebhookValidationError extends Error {
    constructor(message: string);
}

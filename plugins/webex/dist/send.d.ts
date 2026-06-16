/**
 * Webex Message Sending Module
 */
import type { WebexChannelConfig, WebexMessage, OpenClawOutboundMessage } from './types';
export declare class WebexSender {
    private config;
    private apiBaseUrl;
    private retryOptions;
    constructor(config: WebexChannelConfig);
    /**
     * Send a message to Webex
     */
    send(message: OpenClawOutboundMessage): Promise<WebexMessage>;
    /**
     * Send a text message to a room
     */
    sendToRoom(roomId: string, text: string, markdown?: string): Promise<WebexMessage>;
    /**
     * Send a direct message to a person by ID
     */
    sendDirectById(personId: string, text: string, markdown?: string): Promise<WebexMessage>;
    /**
     * Send a direct message to a person by email
     */
    sendDirectByEmail(email: string, text: string, markdown?: string): Promise<WebexMessage>;
    /**
     * Send a message with file attachment
     */
    sendWithFile(roomId: string, text: string, fileUrl: string): Promise<WebexMessage>;
    /**
     * Send a threaded reply
     */
    sendReply(roomId: string, parentId: string, text: string, markdown?: string): Promise<WebexMessage>;
    /**
     * Get a message by ID
     */
    getMessage(messageId: string): Promise<WebexMessage>;
    /**
     * Delete a message by ID
     */
    deleteMessage(messageId: string): Promise<void>;
    /**
     * Build a Webex message request from an OpenClaw outbound message
     */
    private buildMessageRequest;
    /**
     * Create a message via the Webex API
     */
    private createMessage;
    /**
     * Validate a message request before sending
     */
    private validateMessageRequest;
    /**
     * Make an API request with retry logic
     */
    private request;
    /**
     * Execute a single API request
     */
    private executeRequest;
    /**
     * Parse error response from Webex API
     */
    private parseErrorResponse;
    /**
     * Determine if a request should be retried
     */
    private shouldRetry;
    /**
     * Calculate backoff delay with exponential backoff and jitter
     */
    private calculateBackoff;
    /**
     * Sleep for a given number of milliseconds
     */
    private sleep;
}
/**
 * Custom error class for Webex API errors
 */
export declare class WebexApiRequestError extends Error {
    readonly statusCode: number;
    readonly trackingId?: string;
    readonly details?: Array<{
        description: string;
    }>;
    constructor(message: string, statusCode: number, trackingId?: string, details?: Array<{
        description: string;
    }>);
    toJSON(): object;
}

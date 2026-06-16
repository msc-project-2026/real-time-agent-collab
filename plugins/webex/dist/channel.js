"use strict";
/**
 * Webex Channel - Main Channel Logic
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.WebexChannel = void 0;
exports.createWebexChannel = createWebexChannel;
exports.createAndInitialize = createAndInitialize;
const send_1 = require("./send");
const webhook_1 = require("./webhook");
/**
 * Default configuration values
 */
const DEFAULT_CONFIG = {
    dmPolicy: 'allow',
    apiBaseUrl: 'https://webexapis.com/v1',
    maxRetries: 3,
    retryDelayMs: 1000,
};
/**
 * WebexChannel implements the OpenClaw channel plugin interface for Cisco Webex
 */
class WebexChannel {
    name = 'webex';
    version = '1.0.0';
    config = null;
    sender = null;
    webhookHandler = null;
    messageHandlers = [];
    initialized = false;
    /**
     * Initialize the channel with configuration
     */
    async initialize(config) {
        // Validate required config
        this.validateConfig(config);
        // Merge with defaults
        this.config = {
            ...DEFAULT_CONFIG,
            ...config,
        };
        // Initialize sender
        this.sender = new send_1.WebexSender(this.config);
        // Initialize webhook handler
        this.webhookHandler = new webhook_1.WebexWebhookHandler(this.config);
        await this.webhookHandler.initialize();
        this.initialized = true;
    }
    /**
     * Validate configuration
     */
    validateConfig(config) {
        if (!config.token) {
            throw new Error('Webex channel config requires a token');
        }
        if (!config.webhookUrl) {
            throw new Error('Webex channel config requires a webhookUrl');
        }
        if (!config.dmPolicy) {
            throw new Error('Webex channel config requires a dmPolicy');
        }
        if (config.dmPolicy === 'allowlisted' && (!config.allowFrom || config.allowFrom.length === 0)) {
            throw new Error('Webex channel config requires allowFrom when dmPolicy is "allowlisted"');
        }
        // Validate webhook URL format
        try {
            new URL(config.webhookUrl);
        }
        catch {
            throw new Error('Webex channel config webhookUrl must be a valid URL');
        }
    }
    /**
     * Ensure the channel is initialized
     */
    ensureInitialized() {
        if (!this.initialized || !this.config || !this.sender || !this.webhookHandler) {
            throw new Error('Webex channel is not initialized. Call initialize() first.');
        }
    }
    /**
     * Send a message
     */
    async send(message) {
        this.ensureInitialized();
        return this.sender.send(message);
    }
    /**
     * Send a simple text message to a room
     */
    async sendText(roomId, text) {
        return this.send({
            to: roomId,
            content: { text },
        });
    }
    /**
     * Send a markdown message to a room
     */
    async sendMarkdown(roomId, markdown) {
        return this.send({
            to: roomId,
            content: { markdown },
        });
    }
    /**
     * Send a direct message to a person
     */
    async sendDirect(personIdOrEmail, text) {
        return this.send({
            to: personIdOrEmail,
            content: { text },
        });
    }
    /**
     * Reply to a message in a thread
     */
    async reply(roomId, parentId, text) {
        return this.send({
            to: roomId,
            content: { text },
            parentId,
        });
    }
    /**
     * Handle incoming webhook
     */
    async handleWebhook(payload, signature) {
        this.ensureInitialized();
        const envelope = await this.webhookHandler.handleWebhook(payload, signature);
        if (envelope) {
            // Notify all registered handlers
            await this.notifyHandlers(envelope);
        }
        return envelope;
    }
    /**
     * Register a message handler
     */
    onMessage(handler) {
        this.messageHandlers.push(handler);
    }
    /**
     * Remove a message handler
     */
    offMessage(handler) {
        const index = this.messageHandlers.indexOf(handler);
        if (index !== -1) {
            this.messageHandlers.splice(index, 1);
        }
    }
    /**
     * Notify all registered handlers of a new message
     */
    async notifyHandlers(envelope) {
        for (const handler of this.messageHandlers) {
            try {
                await handler(envelope);
            }
            catch (error) {
                console.error('Error in message handler:', error);
            }
        }
    }
    /**
     * Register webhooks with Webex
     */
    async registerWebhooks() {
        this.ensureInitialized();
        return this.webhookHandler.registerWebhooks();
    }
    /**
     * Get the sender instance for advanced operations
     */
    getSender() {
        this.ensureInitialized();
        return this.sender;
    }
    /**
     * Get the webhook handler instance for advanced operations
     */
    getWebhookHandler() {
        this.ensureInitialized();
        return this.webhookHandler;
    }
    /**
     * Get the current configuration
     */
    getConfig() {
        return this.config;
    }
    /**
     * Check if the channel is initialized
     */
    isInitialized() {
        return this.initialized;
    }
    /**
     * Cleanup and shutdown
     */
    async shutdown() {
        this.messageHandlers = [];
        this.sender = null;
        this.webhookHandler = null;
        this.config = null;
        this.initialized = false;
    }
}
exports.WebexChannel = WebexChannel;
/**
 * Create a new Webex channel instance
 */
function createWebexChannel() {
    return new WebexChannel();
}
/**
 * Create and initialize a Webex channel with config
 */
async function createAndInitialize(config) {
    const channel = createWebexChannel();
    await channel.initialize(config);
    return channel;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiY2hhbm5lbC5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uL3NyYy9jaGFubmVsLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7QUFBQTs7R0FFRzs7O0FBc1BILGdEQUVDO0FBS0Qsa0RBSUM7QUFyUEQsaUNBQXFDO0FBQ3JDLHVDQUFnRDtBQUVoRDs7R0FFRztBQUNILE1BQU0sY0FBYyxHQUFnQztJQUNsRCxRQUFRLEVBQUUsT0FBTztJQUNqQixVQUFVLEVBQUUsMEJBQTBCO0lBQ3RDLFVBQVUsRUFBRSxDQUFDO0lBQ2IsWUFBWSxFQUFFLElBQUk7Q0FDbkIsQ0FBQztBQUVGOztHQUVHO0FBQ0gsTUFBYSxZQUFZO0lBQ2QsSUFBSSxHQUFHLE9BQU8sQ0FBQztJQUNmLE9BQU8sR0FBRyxPQUFPLENBQUM7SUFFbkIsTUFBTSxHQUE4QixJQUFJLENBQUM7SUFDekMsTUFBTSxHQUF1QixJQUFJLENBQUM7SUFDbEMsY0FBYyxHQUErQixJQUFJLENBQUM7SUFDbEQsZUFBZSxHQUFxQixFQUFFLENBQUM7SUFDdkMsV0FBVyxHQUFHLEtBQUssQ0FBQztJQUU1Qjs7T0FFRztJQUNILEtBQUssQ0FBQyxVQUFVLENBQUMsTUFBMEI7UUFDekMsMkJBQTJCO1FBQzNCLElBQUksQ0FBQyxjQUFjLENBQUMsTUFBTSxDQUFDLENBQUM7UUFFNUIsc0JBQXNCO1FBQ3RCLElBQUksQ0FBQyxNQUFNLEdBQUc7WUFDWixHQUFHLGNBQWM7WUFDakIsR0FBRyxNQUFNO1NBQ1ksQ0FBQztRQUV4QixvQkFBb0I7UUFDcEIsSUFBSSxDQUFDLE1BQU0sR0FBRyxJQUFJLGtCQUFXLENBQUMsSUFBSSxDQUFDLE1BQU0sQ0FBQyxDQUFDO1FBRTNDLDZCQUE2QjtRQUM3QixJQUFJLENBQUMsY0FBYyxHQUFHLElBQUksNkJBQW1CLENBQUMsSUFBSSxDQUFDLE1BQU0sQ0FBQyxDQUFDO1FBQzNELE1BQU0sSUFBSSxDQUFDLGNBQWMsQ0FBQyxVQUFVLEVBQUUsQ0FBQztRQUV2QyxJQUFJ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SUFDSCxTQUFTO1FBQ1AsSUFBSSxDQUFDLGlCQUFpQixFQUFFLENBQUM7UUFDekIsT0FBTyxJQUFJLENBQUMsTUFBTyxDQUFDO0lBQ3RCLENBQUM7SUFFRDs7T0FFRztJQUNILGlCQUFpQjtRQUNmLElBQUksQ0FBQyxpQkFBaUIsRUFBRSxDQUFDO1FBQ3pCLE9BQU8sSUFBSSxDQUFDLGNBQWUsQ0FBQztJQUM5QixDQUFDO0lBRUQ7O09BRUc7SUFDSCxTQUFTO1FBQ1AsT0FBTyxJQUFJLENBQUMsTUFBTSxDQUFDO0lBQ3JCLENBQUM7SUFFRDs7T0FFRztJQUNILGFBQWE7UUFDWCxPQUFPLElBQUksQ0FBQyxXQUFXLENBQUM7SUFDMUIsQ0FBQztJQUVEOztPQUVHO0lBQ0gsS0FBSyxDQUFDLFFBQVE7UUFDWixJQUFJLENBQUMsZUFBZSxHQUFHLEVBQUUsQ0FBQztRQUMxQixJQUFJLENBQUMsTUFBTSxHQUFHLElBQUksQ0FBQztRQUNuQixJQUFJLENBQUMsY0FBYyxHQUFHLElBQUksQ0FBQztRQUMzQixJQUFJLENBQUMsTUFBTSxHQUFHLElBQUksQ0FBQztRQUNuQixJQUFJLENBQUMsV0FBVyxHQUFHLEtBQUssQ0FBQztJQUMzQixDQUFDO0NBQ0Y7QUFyTkQsb0NBcU5DO0FBRUQ7O0dBRUc7QUFDSCxTQUFnQixrQkFBa0I7SUFDaEMsT0FBTyxJQUFJLFlBQVksRUFBRSxDQUFDO0FBQzVCLENBQUM7QUFFRDs7R0FFRztBQUNJLEtBQUssVUFBVSxtQkFBbUIsQ0FBQyxNQUEwQjtJQUNsRSxNQUFNLE9BQU8sR0FBRyxrQkFBa0IsRUFBRSxDQUFDO0lBQ3JDLE1BQU0sT0FBTyxDQUFDLFVBQVUsQ0FBQyxNQUFNLENBQUMsQ0FBQztJQUNqQyxPQUFPLE9BQU8sQ0FBQztBQUNqQixDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBXZWJleCBDaGFubmVsIC0gTWFpbiBDaGFubmVsIExvZ2ljXG4gKi9cblxuaW1wb3J0IHR5cGUge1xuICBXZWJleENoYW5uZWxDb25maWcsXG4gIFdlYmV4Q2hhbm5lbFBsdWdpbixcbiAgV2ViZXhNZXNzYWdlLFxuICBXZWJleFdlYmhvb2ssXG4gIFdlYmV4V2ViaG9va1BheWxvYWQsXG4gIE9wZW5DbGF3RW52ZWxvcGUsXG4gIE9wZW5DbGF3T3V0Ym91bmRNZXNzYWdlLFxuICBXZWJob29rSGFuZGxlcixcbn0gZnJvbSAnLi90eXBlcyc7XG5pbXBvcnQgeyBXZWJleFNlbmRlciB9IGZyb20gJy4vc2VuZCc7XG5pbXBvcnQgeyBXZWJleFdlYmhvb2tIYW5kbGVyIH0gZnJvbSAnLi93ZWJob29rJztcblxuLyoqXG4gKiBEZWZhdWx0IGNvbmZpZ3VyYXRpb24gdmFsdWVzXG4gKi9cbmNvbnN0IERFRkFVTFRfQ09ORklHOiBQYXJ0aWFsPFdlYmV4Q2hhbm5lbENvbmZpZz4gPSB7XG4gIGRtUG9saWN5OiAnYWxsb3cnLFxuICBhcGlCYXNlVXJsOiAnaHR0cHM6Ly93ZWJleGFwaXMuY29tL3YxJyxcbiAgbWF4UmV0cmllczogMyxcbiAgcmV0cnlEZWxheU1zOiAxMDAwLFxufTtcblxuLyoqXG4gKiBXZWJleENoYW5uZWwgaW1wbGVtZW50cyB0aGUgT3BlbkNsYXcgY2hhbm5lbCBwbHVnaW4gaW50ZXJmYWNlIGZvciBDaXNjbyBXZWJleFxuICovXG5leHBvcnQgY2xhc3MgV2ViZXhDaGFubmVsIGltcGxlbWVudHMgV2ViZXhDaGFubmVsUGx1Z2luIHtcbiAgcmVhZG9ubHkgbmFtZSA9ICd3ZWJleCc7XG4gIHJlYWRvbmx5IHZlcnNpb24gPSAnMS4wLjAnO1xuXG4gIHByaXZhdGUgY29uZmlnOiBXZWJleENoYW5uZWxDb25maWcgfCBudWxsID0gbnVsbDtcbiAgcHJpdmF0ZSBzZW5kZXI6IFdlYmV4U2VuZGVyIHwgbnVsbCA9IG51bGw7XG4gIHByaXZhdGUgd2ViaG9va0hhbmRsZXI6IFdlYmV4V2ViaG9va0hhbmRsZXIgfCBudWxsID0gbnVsbDtcbiAgcHJpdmF0ZSBtZXNzYWdlSGFuZGxlcnM6IFdlYmhvb2tIYW5kbGVyW10gPSBbXTtcbiAgcHJpdmF0ZSBpbml0aWFsaXplZCA9IGZhbHNlO1xuXG4gIC8qKlxuICAgKiBJbml0aWFsaXplIHRoZSBjaGFubmVsIHdpdGggY29uZmlndXJhdGlvblxuICAgKi9cbiAgYXN5bmMgaW5pdGlhbGl6ZShjb25maWc6IFdlYmV4Q2hhbm5lbENvbmZpZyk6IFByb21pc2U8dm9pZD4ge1xuICAgIC8vIFZhbGlkYXRlIHJlcXVpcmVkIGNvbmZpZ1xuICAgIHRoaXMudmFsaWRhdGVDb25maWcoY29uZmlnKTtcblxuICAgIC8vIE1lcmdlIHdpdGggZGVmYXVsdHNcbiAgICB0aGlzLmNvbmZpZyA9IHtcbiAgICAgIC4uLkRFRkFVTFRfQ09ORklHLFxuICAgICAgLi4uY29uZmlnLFxuICAgIH0gYXMgV2ViZXhDaGFubmVsQ29uZmlnO1xuXG4gICAgLy8gSW5pdGlhbGl6ZSBzZW5kZXJcbiAgICB0aGlzLnNlbmRlciA9IG5ldyBXZWJleFNlbmRlcih0aGlzLmNvbmZpZyk7XG5cbiAgICAvLyBJbml0aWFsaXplIHdlYmhvb2sgaGFuZGxlclxuICAgIHRoaXMud2ViaG9va0hhbmRsZXIgPSBuZXcgV2ViZXhXZWJob29rSGFuZGxlcih0aGlzLmNvbmZpZyk7XG4gICAgYXdhaXQgdGhpcy53ZWJob29rSGFuZGxlci5pbml0aWFsaXplKCk7XG5cbiAgICB0aGlzLmluaXRpYWxpemVkID0gdHJ1ZTtcbiAgfVxuXG4gIC8qKlxuICAgKiBWYWxpZGF0ZSBjb25maWd1cmF0aW9uXG4gICAqL1xuICBwcml2YXRlIHZhbGlkYXRlQ29uZmlnKGNvbmZpZzogV2ViZXhDaGFubmVsQ29uZmlnKTogdm9pZCB7XG4gICAgaWYgKCFjb25maWcudG9rZW4pIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcignV2ViZXggY2hhbm5lbCBjb25maWcgcmVxdWlyZXMgYSB0b2tlbicpO1xuICAgIH1cbiAgICBpZiAoIWNvbmZpZy53ZWJob29rVXJsKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoJ1dlYmV4IGNoYW5uZWwgY29uZmlnIHJlcXVpcmVzIGEgd2ViaG9va1VybCcpO1xuICAgIH1cbiAgICBpZiAoIWNvbmZpZy5kbVBvbGljeSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKCdXZWJleCBjaGFubmVsIGNvbmZpZyByZXF1aXJlcyBhIGRtUG9saWN5Jyk7XG4gICAgfVxuICAgIGlmIChjb25maWcuZG1Qb2xpY3kgPT09ICdhbGxvd2xpc3RlZCcgJiYgKCFjb25maWcuYWxsb3dGcm9tIHx8IGNvbmZpZy5hbGxvd0Zyb20ubGVuZ3RoID09PSAwKSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKCdXZWJleCBjaGFubmVsIGNvbmZpZyByZXF1aXJlcyBhbGxvd0Zyb20gd2hlbiBkbVBvbGljeSBpcyBcImFsbG93bGlzdGVkXCInKTtcbiAgICB9XG5cbiAgICAvLyBWYWxpZGF0ZSB3ZWJob29rIFVSTCBmb3JtYXRcbiAgICB0cnkge1xuICAgICAgbmV3IFVSTChjb25maWcud2ViaG9va1VybCk7XG4gICAgfSBjYXRjaCB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoJ1dlYmV4IGNoYW5uZWwgY29uZmlnIHdlYmhvb2tVcmwgbXVzdCBiZSBhIHZhbGlkIFVSTCcpO1xuICAgIH1cbiAgfVxuXG4gIC8qKlxuICAgKiBFbnN1cmUgdGhlIGNoYW5uZWwgaXMgaW5pdGlhbGl6ZWRcbiAgICovXG4gIHByaXZhdGUgZW5zdXJlSW5pdGlhbGl6ZWQoKTogdm9pZCB7XG4gICAgaWYgKCF0aGlzLmluaXRpYWxpemVkIHx8ICF0aGlzLmNvbmZpZyB8fCAhdGhpcy5zZW5kZXIgfHwgIXRoaXMud2ViaG9va0hhbmRsZXIpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcignV2ViZXggY2hhbm5lbCBpcyBub3QgaW5pdGlhbGl6ZWQuIENhbGwgaW5pdGlhbGl6ZSgpIGZpcnN0LicpO1xuICAgIH1cbiAgfVxuXG4gIC8qKlxuICAgKiBTZW5kIGEgbWVzc2FnZVxuICAgKi9cbiAgYXN5bmMgc2VuZChtZXNzYWdlOiBPcGVuQ2xhd091dGJvdW5kTWVzc2FnZSk6IFByb21pc2U8V2ViZXhNZXNzYWdlPiB7XG4gICAgdGhpcy5lbnN1cmVJbml0aWFsaXplZCgpO1xuICAgIHJldHVybiB0aGlzLnNlbmRlciEuc2VuZChtZXNzYWdlKTtcbiAgfVxuXG4gIC8qKlxuICAgKiBTZW5kIGEgc2ltcGxlIHRleHQgbWVzc2FnZSB0byBhIHJvb21cbiAgICovXG4gIGFzeW5jIHNlbmRUZXh0KHJvb21JZDogc3RyaW5nLCB0ZXh0OiBzdHJpbmcpOiBQcm9taXNlPFdlYmV4TWVzc2FnZT4ge1xuICAgIHJldHVybiB0aGlzLnNlbmQoe1xuICAgICAgdG86IHJvb21JZCxcbiAgICAgIGNvbnRlbnQ6IHsgdGV4dCB9LFxuICAgIH0pO1xuICB9XG5cbiAgLyoqXG4gICAqIFNlbmQgYSBtYXJrZG93biBtZXNzYWdlIHRvIGEgcm9vbVxuICAgKi9cbiAgYXN5bmMgc2VuZE1hcmtkb3duKHJvb21JZDogc3RyaW5nLCBtYXJrZG93bjogc3RyaW5nKTogUHJvbWlzZTxXZWJleE1lc3NhZ2U+IHtcbiAgICByZXR1cm4gdGhpcy5zZW5kKHtcbiAgICAgIHRvOiByb29tSWQsXG4gICAgICBjb250ZW50OiB7IG1hcmtkb3duIH0sXG4gICAgfSk7XG4gIH1cblxuICAvKipcbiAgICogU2VuZCBhIGRpcmVjdCBtZXNzYWdlIHRvIGEgcGVyc29uXG4gICAqL1xuICBhc3luYyBzZW5kRGlyZWN0KHBlcnNvbklkT3JFbWFpbDogc3RyaW5nLCB0ZXh0OiBzdHJpbmcpOiBQcm9taXNlPFdlYmV4TWVzc2FnZT4ge1xuICAgIHJldHVybiB0aGlzLnNlbmQoe1xuICAgICAgdG86IHBlcnNvbklkT3JFbWFpbCxcbiAgICAgIGNvbnRlbnQ6IHsgdGV4dCB9LFxuICAgIH0pO1xuICB9XG5cbiAgLyoqXG4gICAqIFJlcGx5IHRvIGEgbWVzc2FnZSBpbiBhIHRocmVhZFxuICAgKi9cbiAgYXN5bmMgcmVwbHkocm9vbUlkOiBzdHJpbmcsIHBhcmVudElkOiBzdHJpbmcsIHRleHQ6IHN0cmluZyk6IFByb21pc2U8V2ViZXhNZXNzYWdlPiB7XG4gICAgcmV0dXJuIHRoaXMuc2VuZCh7XG4gICAgICB0bzogcm9vbUlkLFxuICAgICAgY29udGVudDogeyB0ZXh0IH0sXG4gICAgICBwYXJlbnRJZCxcbiAgICB9KTtcbiAgfVxuXG4gIC8qKlxuICAgKiBIYW5kbGUgaW5jb21pbmcgd2ViaG9va1xuICAgKi9cbiAgYXN5bmMgaGFuZGxlV2ViaG9vayhcbiAgICBwYXlsb2FkOiBXZWJleFdlYmhvb2tQYXlsb2FkLFxuICAgIHNpZ25hdHVyZT86IHN0cmluZ1xuICApOiBQcm9taXNlPE9wZW5DbGF3RW52ZWxvcGUgfCBudWxsPiB7XG4gICAgdGhpcy5lbnN1cmVJbml0aWFsaXplZCgpO1xuXG4gICAgY29uc3QgZW52ZWxvcGUgPSBhd2FpdCB0aGlzLndlYmhvb2tIYW5kbGVyIS5oYW5kbGVXZWJob29rKHBheWxvYWQsIHNpZ25hdHVyZSk7XG5cbiAgICBpZiAoZW52ZWxvcGUpIHtcbiAgICAgIC8vIE5vdGlmeSBhbGwgcmVnaXN0ZXJlZCBoYW5kbGVyc1xuICAgICAgYXdhaXQgdGhpcy5ub3RpZnlIYW5kbGVycyhlbnZlbG9wZSk7XG4gICAgfVxuXG4gICAgcmV0dXJuIGVudmVsb3BlO1xuICB9XG5cbiAgLyoqXG4gICAqIFJlZ2lzdGVyIGEgbWVzc2FnZSBoYW5kbGVyXG4gICAqL1xuICBvbk1lc3NhZ2UoaGFuZGxlcjogV2ViaG9va0hhbmRsZXIpOiB2b2lkIHtcbiAgICB0aGlzLm1lc3NhZ2VIYW5kbGVycy5wdXNoKGhhbmRsZXIpO1xuICB9XG5cbiAgLyoqXG4gICAqIFJlbW92ZSBhIG1lc3NhZ2UgaGFuZGxlclxuICAgKi9cbiAgb2ZmTWVzc2FnZShoYW5kbGVyOiBXZWJob29rSGFuZGxlcik6IHZvaWQge1xuICAgIGNvbnN0IGluZGV4ID0gdGhpcy5tZXNzYWdlSGFuZGxlcnMuaW5kZXhPZihoYW5kbGVyKTtcbiAgICBpZiAoaW5kZXggIT09IC0xKSB7XG4gICAgICB0aGlzLm1lc3NhZ2VIYW5kbGVycy5zcGxpY2UoaW5kZXgsIDEpO1xuICAgIH1cbiAgfVxuXG4gIC8qKlxuICAgKiBOb3RpZnkgYWxsIHJlZ2lzdGVyZWQgaGFuZGxlcnMgb2YgYSBuZXcgbWVzc2FnZVxuICAgKi9cbiAgcHJpdmF0ZSBhc3luYyBub3RpZnlIYW5kbGVycyhlbnZlbG9wZTogT3BlbkNsYXdFbnZlbG9wZSk6IFByb21pc2U8dm9pZD4ge1xuICAgIGZvciAoY29uc3QgaGFuZGxlciBvZiB0aGlzLm1lc3NhZ2VIYW5kbGVycykge1xuICAgICAgdHJ5IHtcbiAgICAgICAgYXdhaXQgaGFuZGxlcihlbnZlbG9wZSk7XG4gICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICBjb25zb2xlLmVycm9yKCdFcnJvciBpbiBtZXNzYWdlIGhhbmRsZXI6JywgZXJyb3IpO1xuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIC8qKlxuICAgKiBSZWdpc3RlciB3ZWJob29rcyB3aXRoIFdlYmV4XG4gICAqL1xuICBhc3luYyByZWdpc3RlcldlYmhvb2tzKCk6IFByb21pc2U8V2ViZXhXZWJob29rW10+IHtcbiAgICB0aGlzLmVuc3VyZUluaXRpYWxpemVkKCk7XG4gICAgcmV0dXJuIHRoaXMud2ViaG9va0hhbmRsZXIhLnJlZ2lzdGVyV2ViaG9va3MoKTtcbiAgfVxuXG4gIC8qKlxuICAgKiBHZXQgdGhlIHNlbmRlciBpbnN0YW5jZSBmb3IgYWR2YW5jZWQgb3BlcmF0aW9uc1xuICAgKi9cbiAgZ2V0U2VuZGVyKCk6IFdlYmV4U2VuZGVyIHtcbiAgICB0aGlzLmVuc3VyZUluaXRpYWxpemVkKCk7XG4gICAgcmV0dXJuIHRoaXMuc2VuZGVyITtcbiAgfVxuXG4gIC8qKlxuICAgKiBHZXQgdGhlIHdlYmhvb2sgaGFuZGxlciBpbnN0YW5jZSBmb3IgYWR2YW5jZWQgb3BlcmF0aW9uc1xuICAgKi9cbiAgZ2V0V2ViaG9va0hhbmRsZXIoKTogV2ViZXhXZWJob29rSGFuZGxlciB7XG4gICAgdGhpcy5lbnN1cmVJbml0aWFsaXplZCgpO1xuICAgIHJldHVybiB0aGlzLndlYmhvb2tIYW5kbGVyITtcbiAgfVxuXG4gIC8qKlxuICAgKiBHZXQgdGhlIGN1cnJlbnQgY29uZmlndXJhdGlvblxuICAgKi9cbiAgZ2V0Q29uZmlnKCk6IFdlYmV4Q2hhbm5lbENvbmZpZyB8IG51bGwge1xuICAgIHJldHVybiB0aGlzLmNvbmZpZztcbiAgfVxuXG4gIC8qKlxuICAgKiBDaGVjayBpZiB0aGUgY2hhbm5lbCBpcyBpbml0aWFsaXplZFxuICAgKi9cbiAgaXNJbml0aWFsaXplZCgpOiBib29sZWFuIHtcbiAgICByZXR1cm4gdGhpcy5pbml0aWFsaXplZDtcbiAgfVxuXG4gIC8qKlxuICAgKiBDbGVhbnVwIGFuZCBzaHV0ZG93blxuICAgKi9cbiAgYXN5bmMgc2h1dGRvd24oKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgdGhpcy5tZXNzYWdlSGFuZGxlcnMgPSBbXTtcbiAgICB0aGlzLnNlbmRlciA9IG51bGw7XG4gICAgdGhpcy53ZWJob29rSGFuZGxlciA9IG51bGw7XG4gICAgdGhpcy5jb25maWcgPSBudWxsO1xuICAgIHRoaXMuaW5pdGlhbGl6ZWQgPSBmYWxzZTtcbiAgfVxufVxuXG4vKipcbiAqIENyZWF0ZSBhIG5ldyBXZWJleCBjaGFubmVsIGluc3RhbmNlXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBjcmVhdGVXZWJleENoYW5uZWwoKTogV2ViZXhDaGFubmVsIHtcbiAgcmV0dXJuIG5ldyBXZWJleENoYW5uZWwoKTtcbn1cblxuLyoqXG4gKiBDcmVhdGUgYW5kIGluaXRpYWxpemUgYSBXZWJleCBjaGFubmVsIHdpdGggY29uZmlnXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBjcmVhdGVBbmRJbml0aWFsaXplKGNvbmZpZzogV2ViZXhDaGFubmVsQ29uZmlnKTogUHJvbWlzZTxXZWJleENoYW5uZWw+IHtcbiAgY29uc3QgY2hhbm5lbCA9IGNyZWF0ZVdlYmV4Q2hhbm5lbCgpO1xuICBhd2FpdCBjaGFubmVsLmluaXRpYWxpemUoY29uZmlnKTtcbiAgcmV0dXJuIGNoYW5uZWw7XG59XG4iXX0=
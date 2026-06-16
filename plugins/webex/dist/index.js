"use strict";
/**
 * OpenClaw Webex Channel Plugin
 *
 * A channel plugin for integrating Cisco Webex messaging with OpenClaw.
 *
 * @packageDocumentation
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.webexPlugin = exports.createAndInitialize = exports.createWebexChannel = exports.WebexChannel = exports.WebhookValidationError = exports.WebexWebhookHandler = exports.WebexApiRequestError = exports.WebexSender = exports.id = exports.default = void 0;
// Re-export the plugin registration function as default
var plugin_1 = require("./plugin");
Object.defineProperty(exports, "default", { enumerable: true, get: function () { return __importDefault(plugin_1).default; } });
var plugin_2 = require("./plugin");
Object.defineProperty(exports, "id", { enumerable: true, get: function () { return plugin_2.id; } });
// Re-export existing classes for backwards compatibility and advanced usage
var send_1 = require("./send");
Object.defineProperty(exports, "WebexSender", { enumerable: true, get: function () { return send_1.WebexSender; } });
Object.defineProperty(exports, "WebexApiRequestError", { enumerable: true, get: function () { return send_1.WebexApiRequestError; } });
var webhook_1 = require("./webhook");
Object.defineProperty(exports, "WebexWebhookHandler", { enumerable: true, get: function () { return webhook_1.WebexWebhookHandler; } });
Object.defineProperty(exports, "WebhookValidationError", { enumerable: true, get: function () { return webhook_1.WebhookValidationError; } });
var channel_1 = require("./channel");
Object.defineProperty(exports, "WebexChannel", { enumerable: true, get: function () { return channel_1.WebexChannel; } });
Object.defineProperty(exports, "createWebexChannel", { enumerable: true, get: function () { return channel_1.createWebexChannel; } });
Object.defineProperty(exports, "createAndInitialize", { enumerable: true, get: function () { return channel_1.createAndInitialize; } });
var channel_plugin_1 = require("./channel-plugin");
Object.defineProperty(exports, "webexPlugin", { enumerable: true, get: function () { return channel_plugin_1.webexPlugin; } });
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW5kZXguanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi9zcmMvaW5kZXgudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IjtBQUFBOzs7Ozs7R0FNRzs7Ozs7O0FBRUgsd0RBQXdEO0FBQ3hELG1DQUFtQztBQUExQixrSEFBQSxPQUFPLE9BQUE7QUFDaEIsbUNBQThCO0FBQXJCLDRGQUFBLEVBQUUsT0FBQTtBQUVYLDRFQUE0RTtBQUM1RSwrQkFBMkQ7QUFBbEQsbUdBQUEsV0FBVyxPQUFBO0FBQUUsNEdBQUEsb0JBQW9CLE9BQUE7QUFDMUMscUNBQXdFO0FBQS9ELDhHQUFBLG1CQUFtQixPQUFBO0FBQUUsaUhBQUEsc0JBQXNCLE9BQUE7QUFDcEQscUNBQWtGO0FBQXpFLHVHQUFBLFlBQVksT0FBQTtBQUFFLDZHQUFBLGtCQUFrQixPQUFBO0FBQUUsOEdBQUEsbUJBQW1CLE9BQUE7QUFDOUQsbURBQStDO0FBQXRDLDZHQUFBLFdBQVcsT0FBQSIsInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogT3BlbkNsYXcgV2ViZXggQ2hhbm5lbCBQbHVnaW5cbiAqXG4gKiBBIGNoYW5uZWwgcGx1Z2luIGZvciBpbnRlZ3JhdGluZyBDaXNjbyBXZWJleCBtZXNzYWdpbmcgd2l0aCBPcGVuQ2xhdy5cbiAqXG4gKiBAcGFja2FnZURvY3VtZW50YXRpb25cbiAqL1xuXG4vLyBSZS1leHBvcnQgdGhlIHBsdWdpbiByZWdpc3RyYXRpb24gZnVuY3Rpb24gYXMgZGVmYXVsdFxuZXhwb3J0IHsgZGVmYXVsdCB9IGZyb20gXCIuL3BsdWdpblwiO1xuZXhwb3J0IHsgaWQgfSBmcm9tIFwiLi9wbHVnaW5cIjtcblxuLy8gUmUtZXhwb3J0IGV4aXN0aW5nIGNsYXNzZXMgZm9yIGJhY2t3YXJkcyBjb21wYXRpYmlsaXR5IGFuZCBhZHZhbmNlZCB1c2FnZVxuZXhwb3J0IHsgV2ViZXhTZW5kZXIsIFdlYmV4QXBpUmVxdWVzdEVycm9yIH0gZnJvbSBcIi4vc2VuZFwiO1xuZXhwb3J0IHsgV2ViZXhXZWJob29rSGFuZGxlciwgV2ViaG9va1ZhbGlkYXRpb25FcnJvciB9IGZyb20gXCIuL3dlYmhvb2tcIjtcbmV4cG9ydCB7IFdlYmV4Q2hhbm5lbCwgY3JlYXRlV2ViZXhDaGFubmVsLCBjcmVhdGVBbmRJbml0aWFsaXplIH0gZnJvbSBcIi4vY2hhbm5lbFwiO1xuZXhwb3J0IHsgd2ViZXhQbHVnaW4gfSBmcm9tIFwiLi9jaGFubmVsLXBsdWdpblwiO1xuXG4vLyBSZS1leHBvcnQgdHlwZXNcbmV4cG9ydCB0eXBlIHtcbiAgV2ViZXhDaGFubmVsQ29uZmlnLFxuICBEbVBvbGljeSxcbiAgV2ViZXhQZXJzb24sXG4gIFdlYmV4Um9vbSxcbiAgV2ViZXhNZXNzYWdlLFxuICBXZWJleEF0dGFjaG1lbnQsXG4gIEFkYXB0aXZlQ2FyZCxcbiAgV2ViZXhXZWJob29rLFxuICBXZWJleFdlYmhvb2tSZXNvdXJjZSxcbiAgV2ViZXhXZWJob29rRXZlbnQsXG4gIFdlYmV4V2ViaG9va1BheWxvYWQsXG4gIFdlYmV4V2ViaG9va0RhdGEsXG4gIENyZWF0ZU1lc3NhZ2VSZXF1ZXN0LFxuICBDcmVhdGVXZWJob29rUmVxdWVzdCxcbiAgV2ViZXhBcGlFcnJvcixcbiAgUGFnaW5hdGVkUmVzcG9uc2UsXG4gIE9wZW5DbGF3RW52ZWxvcGUsXG4gIE9wZW5DbGF3QXR0YWNobWVudCxcbiAgT3BlbkNsYXdPdXRib3VuZE1lc3NhZ2UsXG4gIFdlYmV4Q2hhbm5lbFBsdWdpbixcbiAgV2ViaG9va0hhbmRsZXIsXG4gIFJldHJ5T3B0aW9ucyxcbiAgUmVxdWVzdE9wdGlvbnMsXG59IGZyb20gXCIuL3R5cGVzXCI7XG5cbmV4cG9ydCB0eXBlIHsgUmVzb2x2ZWRXZWJleEFjY291bnQgfSBmcm9tIFwiLi9jaGFubmVsLXBsdWdpblwiO1xuIl19
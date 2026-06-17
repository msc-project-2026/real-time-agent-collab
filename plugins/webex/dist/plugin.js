'use strict';
/**
 * OpenClaw Webex Channel Plugin
 *
 * Main entry point for the OpenClaw plugin system.
 * Exports a default function that registers the Webex channel.
 */
Object.defineProperty(exports, '__esModule', { value: true });
exports.id = void 0;
exports.default = register;
const channel_plugin_1 = require('./channel-plugin');
/**
 * OpenClaw plugin registration function.
 *
 * This is the entry point that OpenClaw calls when loading the plugin.
 * It registers the Webex channel with the plugin system.
 */
function register(api) {
  // Store the plugin runtime for use in HTTP handlers
  (0, channel_plugin_1.setPluginRuntime)(api.runtime);
  api.registerChannel({ plugin: channel_plugin_1.webexPlugin });

  // api.registerHttpHandler((0, channel_plugin_1.createWebhookHandler)());
  // Forked from @jimiford/webex v0.1.3: updated registerHttpHandler to
  // registerHttpRoute to match current OpenClaw plugin API.
  api.registerHttpRoute({
    path: '/webhooks/webex/',
    auth: 'plugin',
    match: 'prefix',
    handler: (0, channel_plugin_1.createWebhookHandler)(),
  });
}
// Export the plugin ID for reference
exports.id = 'webex';
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicGx1Z2luLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vc3JjL3BsdWdpbi50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiO0FBQUE7Ozs7O0dBS0c7OztBQVdILDJCQU1DO0FBZEQscURBQXVGO0FBRXZGOzs7OztHQUtHO0FBQ0gsU0FBd0IsUUFBUSxDQUFDLEdBQXNCO0lBQ3JELG9EQUFvRDtJQUNwRCxJQUFBLGlDQUFnQixFQUFDLEdBQUcsQ0FBQyxPQUFPLENBQUMsQ0FBQztJQUU5QixHQUFHLENBQUMsZUFBZSxDQUFDLEVBQUUsTUFBTSxFQUFFLDRCQUFXLEVBQUUsQ0FBQyxDQUFDO0lBQzdDLEdBQUcsQ0FBQyxtQkFBbUIsQ0FBQyxJQUFBLHFDQUFvQixHQUFFLENBQUMsQ0FBQztBQUNsRCxDQUFDO0FBRUQscUNBQXFDO0FBQ3hCLFFBQUEsRUFBRSxHQUFHLE9BQU8sQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogT3BlbkNsYXcgV2ViZXggQ2hhbm5lbCBQbHVnaW5cbiAqXG4gKiBNYWluIGVudHJ5IHBvaW50IGZvciB0aGUgT3BlbkNsYXcgcGx1Z2luIHN5c3RlbS5cbiAqIEV4cG9ydHMgYSBkZWZhdWx0IGZ1bmN0aW9uIHRoYXQgcmVnaXN0ZXJzIHRoZSBXZWJleCBjaGFubmVsLlxuICovXG5cbmltcG9ydCB0eXBlIHsgT3BlbkNsYXdQbHVnaW5BcGkgfSBmcm9tIFwib3BlbmNsYXcvcGx1Z2luLXNka1wiO1xuaW1wb3J0IHsgd2ViZXhQbHVnaW4sIGNyZWF0ZVdlYmhvb2tIYW5kbGVyLCBzZXRQbHVnaW5SdW50aW1lIH0gZnJvbSBcIi4vY2hhbm5lbC1wbHVnaW5cIjtcblxuLyoqXG4gKiBPcGVuQ2xhdyBwbHVnaW4gcmVnaXN0cmF0aW9uIGZ1bmN0aW9uLlxuICpcbiAqIFRoaXMgaXMgdGhlIGVudHJ5IHBvaW50IHRoYXQgT3BlbkNsYXcgY2FsbHMgd2hlbiBsb2FkaW5nIHRoZSBwbHVnaW4uXG4gKiBJdCByZWdpc3RlcnMgdGhlIFdlYmV4IGNoYW5uZWwgd2l0aCB0aGUgcGx1Z2luIHN5c3RlbS5cbiAqL1xuZXhwb3J0IGRlZmF1bHQgZnVuY3Rpb24gcmVnaXN0ZXIoYXBpOiBPcGVuQ2xhd1BsdWdpbkFwaSk6IHZvaWQge1xuICAvLyBTdG9yZSB0aGUgcGx1Z2luIHJ1bnRpbWUgZm9yIHVzZSBpbiBIVFRQIGhhbmRsZXJzXG4gIHNldFBsdWdpblJ1bnRpbWUoYXBpLnJ1bnRpbWUpO1xuICBcbiAgYXBpLnJlZ2lzdGVyQ2hhbm5lbCh7IHBsdWdpbjogd2ViZXhQbHVnaW4gfSk7XG4gIGFwaS5yZWdpc3Rlckh0dHBIYW5kbGVyKGNyZWF0ZVdlYmhvb2tIYW5kbGVyKCkpO1xufVxuXG4vLyBFeHBvcnQgdGhlIHBsdWdpbiBJRCBmb3IgcmVmZXJlbmNlXG5leHBvcnQgY29uc3QgaWQgPSBcIndlYmV4XCI7XG4iXX0=

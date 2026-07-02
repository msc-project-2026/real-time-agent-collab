// Entry point: registers the Webex channel plugin, HTTP route, and plugin tools with the OpenClaw plugin API.
'use strict';

const { appendPendingMessageTool } = require('./tools/append-pending-message');

const { webexPlugin } = require('./channel');
const { webhookRouter } = require('./webhook');
const { setRuntime } = require('./inbound');

function register(api) {
  setRuntime(api.runtime);

  // Channel
  api.registerChannel({ plugin: webexPlugin });

  // Routes
  api.registerHttpRoute({
    path: '/webhooks/webex/',
    auth: 'plugin',
    match: 'prefix',
    handler: webhookRouter,
  });

  // Tools
  api.registerTool(appendPendingMessageTool());
}

module.exports = register;
module.exports.default = register;
module.exports.id = 'webex';
module.exports.webexPlugin = webexPlugin;

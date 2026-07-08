// Entry point: registers the Webex channel plugin, HTTP route, and plugin tools with the OpenClaw plugin API.
'use strict';

const { appendPendingMessageTool } = require('./tools/append-pending-message');
const { stagePendingBatchTool } = require('./tools/stage-pending-batch');
const { readProcessingBatchTool } = require('./tools/read-processing-batch');
const {
  completeProcessingBatchTool,
} = require('./tools/complete-processing-batch');

const { webexPlugin } = require('./channel');
const { webhookRouter } = require('./webhook');
const { setPluginRuntime } = require('./runtime');

function register(api) {
  setPluginRuntime(api.runtime);

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
  api.registerTool(stagePendingBatchTool());
  api.registerTool(readProcessingBatchTool());
  api.registerTool(completeProcessingBatchTool());
}

module.exports = register;
module.exports.default = register;
module.exports.id = 'webex';
module.exports.webexPlugin = webexPlugin;

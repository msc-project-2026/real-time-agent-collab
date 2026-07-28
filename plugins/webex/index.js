// Entry point: registers the Webex channel plugin, HTTP route, and plugin tools with the OpenClaw plugin API.
'use strict';

const { loadProcessingBatchTool } = require('./tools/load-processing-batch');
const {
  completeProcessingBatchTool,
} = require('./tools/complete-processing-batch');

const { webexPlugin } = require('./channel');
const { webhookRouter } = require('./webhook/router');
const { contextRouter } = require('./visibility/context-router');
const { boardRouter } = require('./visibility/board-router');
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

  api.registerHttpRoute({
    path: '/webex/collab/board',
    auth: 'plugin',
    match: 'prefix',
    handler: boardRouter,
  });

  api.registerHttpRoute({
    path: '/webex/collab/',
    auth: 'plugin',
    match: 'prefix',
    handler: contextRouter,
  });

  // Tools
  api.registerTool(loadProcessingBatchTool());
  api.registerTool(completeProcessingBatchTool());
}

module.exports = register;
module.exports.default = register;
module.exports.id = 'webex';
module.exports.webexPlugin = webexPlugin;

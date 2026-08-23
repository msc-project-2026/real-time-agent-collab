// Entry point: registers the Webex channel plugin, HTTP route, and plugin tools with the OpenClaw plugin API.
'use strict';

const { loadProcessingBatchTool } = require('./tools/load-processing-batch');
const {
  completeProcessingBatchTool,
} = require('./tools/complete-processing-batch');
const { tagMessageTool } = require('./tagging/tool');
const { writeTaskTool } = require('./processing/write-task-tool');
const { searchTasksTool } = require('./processing/search-tasks-tool');

const { webexPlugin } = require('./channel');
const { webhookRouter } = require('./webhook/router');
const { contextRouter } = require('./visibility/context-router');
const { boardRouter } = require('./visibility/board-router');
const { setPluginRuntime, setPluginConfig } = require('./runtime');
const { evalRouter } = require('./eval/router');

function register(api) {
  setPluginRuntime(api.runtime);
  setPluginConfig(api.pluginConfig);

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

  if (process.env.WEBEX_EVAL_ROUTES_ENABLED === 'true') {
    api.registerHttpRoute({
      path: '/webex/collab/eval/',
      auth: 'plugin',
      match: 'prefix',
      handler: evalRouter,
    });
  }

  api.registerHttpRoute({
    path: '/webex/collab/',
    auth: 'plugin',
    match: 'prefix',
    handler: contextRouter,
  });

  // Tools
  // route_message (routing/tool.js) is no longer registered — deterministic
  // dispatch (tagging/decide.js, phase 3) replaced the routing LLM classifier
  // that was its only caller. The module survives for now as a plain function
  // still exercised by processing-pipeline tests; full removal is routing/*'s
  // formal retirement (v3 migration phase 5+).
  api.registerTool(tagMessageTool());
  api.registerTool(writeTaskTool());
  api.registerTool(searchTasksTool());
  api.registerTool(loadProcessingBatchTool());
  api.registerTool(completeProcessingBatchTool());
}

module.exports = register;
module.exports.default = register;
module.exports.id = 'webex';
module.exports.webexPlugin = webexPlugin;

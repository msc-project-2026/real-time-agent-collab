// Entry point: registers the Webex channel plugin, HTTP route, and plugin tools with the OpenClaw plugin API.
'use strict';

const { tagMessageTool } = require('./processing/gate/tool');
const { writeTaskTool } = require('./processing/extract/tool');
const { searchTasksTool } = require('./processing/search-tasks-tool');
const { writeSummaryTool } = require('./processing/summarize/tool');
const { searchRecallTool } = require('./processing/search-recall-tool');

const { webexPlugin } = require('./channel');
const { webhookRouter } = require('./webhook/router');
const { spaceRouter } = require('./visibility/space-router');
const { boardRouter } = require('./visibility/board-router');
const { setPluginRuntime, setPluginConfig } = require('./runtime');
const { registerEvalGatewayMethod } = require('./eval/gateway-method');

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

  api.registerHttpRoute({
    path: '/webex/collab/',
    auth: 'plugin',
    match: 'prefix',
    handler: spaceRouter,
  });

  // Tools
  api.registerTool(tagMessageTool());
  api.registerTool(writeTaskTool());
  api.registerTool(searchTasksTool());
  api.registerTool(writeSummaryTool());
  api.registerTool(searchRecallTool());

  // Phase 8 eval — `webex.eval.run` gateway method (operator.write), driven
  // via `openclaw gateway call` from the deployment. See eval/gateway-method.js.
  registerEvalGatewayMethod(api);
}

module.exports = register;
module.exports.default = register;
module.exports.id = 'webex';
module.exports.webexPlugin = webexPlugin;

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
    handler: spaceRouter,
  });

  // Tools
  api.registerTool(tagMessageTool());
  api.registerTool(writeTaskTool());
  api.registerTool(searchTasksTool());
  api.registerTool(writeSummaryTool());
  api.registerTool(searchRecallTool());
}

module.exports = register;
module.exports.default = register;
module.exports.id = 'webex';
module.exports.webexPlugin = webexPlugin;

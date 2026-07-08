// Entry point for the deployment plugin. Registers:
//   - two dispatch-target channels (deploy, deploy-debug) for model tiering,
//   - the deploy-cli tools (deploy/redeploy/list/status/logs/stop/start/remove/
//     url/resources) that run over SSH,
//   - the handoff tools (request_deployment, escalate_debug) that route between
//     the main, deployer, and debugger agents.
'use strict';

const {
  setRuntime,
  deployChannelPlugin,
  debugChannelPlugin,
} = require('./channel.js');
const cliTools = require('./cli-tools.js');
const handoffTools = require('./handoff-tools.js');

function register(api) {
  setRuntime(api.runtime);

  api.registerChannel({ plugin: deployChannelPlugin });
  api.registerChannel({ plugin: debugChannelPlugin });

  cliTools.register(api);
  handoffTools.register(api);
}

module.exports = register;
module.exports.default = register;
module.exports.id = 'deploy-agent';

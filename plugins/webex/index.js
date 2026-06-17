// Entry point: registers the Webex channel plugin and HTTP route with the OpenClaw plugin API.
'use strict';

const { webexPlugin } = require('./channel');
const { webhookRouter } = require('./webhook');
const { setRuntime } = require('./inbound');

function register(api) {
  setRuntime(api.runtime);

  api.registerChannel({ plugin: webexPlugin });
  api.registerHttpRoute({
    path: '/webhooks/webex/',
    auth: 'plugin',
    match: 'prefix',
    handler: webhookRouter,
  });
}

module.exports = register;
module.exports.default = register;
module.exports.id = 'webex';
module.exports.webexPlugin = webexPlugin;

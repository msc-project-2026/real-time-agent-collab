// Entry point: registers the meetingfinder plugin and HTTP route with OpenClaw.
//

'use strict';

const { meetingfinderPlugin } = require('./channel');
const { webhookRouter } = require('../webex/webhook');

function register(api) {
  api.registerChannel({ plugin: meetingfinderPlugin });
  api.registerHttpRoute({
    path: '/webhooks/meetingfinder/',
    auth: 'plugin',
    match: 'prefix',
    handler: webhookRouter,
  });
}

module.exports = register;
module.exports.default = register;
module.exports.id = 'meetingfinder';
module.exports.meetingfinderPlugin = meetingfinderPlugin;

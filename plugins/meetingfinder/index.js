// Entry point: registers the meetingfinder plugin and HTTP route with OpenClaw.
//
// Reuses plugins/webex/webhook.js's targets registry and webhookRouter as-is —
// that code is resource-agnostic (HMAC verify + path dispatch), so meetingfinder
// just adds its own entry under a different path prefix rather than duplicating it.
'use strict';

const { meetingfinderPlugin } = require('./channel');
const { webhookRouter } = require('../webex/webhook');
const { roomLookupRoute } = require('./room-lookup-route');

function register(api) {
  api.registerChannel({ plugin: meetingfinderPlugin });
  api.registerHttpRoute({
    path: '/webhooks/meetingfinder/',
    auth: 'plugin',
    match: 'prefix',
    handler: webhookRouter,
  });
  // Testing route only — see room-lookup-route.js. Not part of the plugin's
  // real webhook-driven flow.
  api.registerHttpRoute({
    path: '/meetingfinder/lookup/',
    auth: 'plugin',
    match: 'prefix',
    handler: roomLookupRoute,
  });
}

module.exports = register;
module.exports.default = register;
module.exports.id = 'meetingfinder';
module.exports.meetingfinderPlugin = meetingfinderPlugin;
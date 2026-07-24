// Entry point: registers the periodic source observer channel with OpenClaw.
'use strict';

const { sourceObserverPlugin, setRuntime } = require('./channel');

function register(api) {
  setRuntime(api.runtime);
  api.registerChannel({ plugin: sourceObserverPlugin });
}

module.exports = register;
module.exports.default = register;
module.exports.id = 'source-observer';
module.exports.sourceObserverPlugin = sourceObserverPlugin;

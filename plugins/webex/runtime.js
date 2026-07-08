// ********* RUNTIME.JS *********
'use strict';

// Holds the OpenClaw plugin runtime (set via setPluginRuntime() by register() in index.js).
let pluginRuntime = null;

function setPluginRuntime(runtime) {
  pluginRuntime = runtime;
}

function getPluginRuntime() {
  if (!pluginRuntime) {
    throw new Error('pluginRuntime has not been set');
  }

  return pluginRuntime;
}

module.exports = {
  setPluginRuntime,
  getPluginRuntime,
};

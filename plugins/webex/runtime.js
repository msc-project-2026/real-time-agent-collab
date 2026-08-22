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

// Holds plugin-specific config (set via setPluginConfig() by register() in index.js).
let pluginConfig = null;

function setPluginConfig(config) {
  pluginConfig = config ?? {};
}

function getRoutingAgentId() {
  return pluginConfig?.routingAgentId ?? 'main';
}

function getPluginConfig() {
  return pluginConfig ?? {};
}

module.exports = {
  setPluginRuntime,
  getPluginRuntime,
  setPluginConfig,
  getPluginConfig,
  getRoutingAgentId,
};

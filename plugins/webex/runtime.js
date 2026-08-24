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

// v3 §9 recall (phase 7) — a separate, independently-configurable agent id
// for resolving the /v1/embeddings endpoint's memorySearch config. Distinct
// from routingAgentId (which is specifically about message-routing
// classification, per its own config description) on principle — the two
// are independent concerns that happen to default to the same value.
// Defaults to routingAgentId's own resolution when unset, so a host that
// hasn't configured this explicitly sees no change in behavior.
function getEmbeddingsAgentId() {
  return pluginConfig?.embeddingsAgentId ?? getRoutingAgentId();
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
  getEmbeddingsAgentId,
};

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

// Dedicated agent identity (response-policy revision follow-up) — every
// spawn this plugin makes (gate/extract/summarize/respond) targets this id,
// not the host's own default agent, so this plugin's spawns get their own
// isolated workspace/agent dir and bootstrap content instead of silently
// inheriting whatever the host's "main" agent happens to have. Renamed from
// getRoutingAgentId()/routingAgentId — collabAgentId is self-documenting now
// that the id itself is literally "collab-agent". Defaults to 'main' for a
// host that hasn't configured this yet, matching the pre-rename default.
function getCollabAgentId() {
  return pluginConfig?.collabAgentId ?? 'main';
}

// v3 §9 recall (phase 7) — a separate, independently-configurable agent id
// for resolving the /v1/embeddings endpoint's memorySearch config. Distinct
// from collabAgentId (which is specifically about message-processing
// spawns, per its own config description) on principle — the two are
// independent concerns that happen to default to the same value. Defaults
// to collabAgentId's own resolution when unset, so a host that hasn't
// configured this explicitly sees no change in behavior.
function getEmbeddingsAgentId() {
  return pluginConfig?.embeddingsAgentId ?? getCollabAgentId();
}

function getPluginConfig() {
  return pluginConfig ?? {};
}

module.exports = {
  setPluginRuntime,
  getPluginRuntime,
  setPluginConfig,
  getPluginConfig,
  getCollabAgentId,
  getEmbeddingsAgentId,
};

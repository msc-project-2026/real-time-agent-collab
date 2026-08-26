// ********* EMBEDDINGS/CLIENT.JS *********
'use strict';

// v3 §9 recall — thin wrapper around the gateway's own OpenAI-compatible
// /v1/embeddings HTTP endpoint. Confirmed live against the deployed gateway
// (phase-7 plan §0 spike) — this is the single seam the rest of the recall
// feature depends on for turning text into vectors; if the embeddings source
// ever changes, only this file needs to.
//
// Two gotchas below, both confirmed live, not guessed:
// - The endpoint resolves its embedding provider from whichever agent's
//   `memorySearch` config `getEmbeddingsAgentId()` points at (host-owned
//   config, same pattern as collabAgentId — see runtime.js; a separate
//   field on principle, since "which agent handles message-routing spawns"
//   and "which agent's memorySearch config to resolve embeddings from" are
//   independent concerns that happen to default to the same value). If it's
//   missing or `"none"`, this throws; callers (write_summary/search_recall
//   tools) must catch and fail soft, same { ok: false } pattern every tool
//   in this plugin already follows.
// - The request must carry an explicit `x-openclaw-model` header shaped
//   `<provider>/<model>`. Relying on the config-level `model` field alone
//   fails: the endpoint splits that field on its first `/` and rejects
//   anything before it that isn't the configured provider name — but the
//   Cisco proxy's own model ids already contain a `/` (e.g.
//   `azure/text-embedding-3-small`, its own litellm-style backend routing,
//   unrelated to OpenClaw's provider system), so the raw config value alone
//   gets misparsed as a provider-override attempt.
// - The request's own `model` field must target this same agent explicitly
//   (`openclaw/<agentId>`), not the bare `"openclaw"` shorthand — the bare
//   form resolves server-side to whichever agent is `default: true`, which
//   is only guaranteed to match `getEmbeddingsAgentId()` when that field is
//   left unset.

const { getEmbeddingsAgentId } = require('../runtime');

function resolveMemorySearchConfig(pluginRuntime, agentId) {
  const cfg = pluginRuntime.config.current();
  const agentEntry = (cfg?.agents?.list ?? []).find((entry) => entry?.id === agentId);

  return agentEntry?.memorySearch ?? cfg?.agents?.defaults?.memorySearch ?? null;
}

function resolveGatewayBaseUrl() {
  const port = process.env.PORT ?? process.env.OPENCLAW_GATEWAY_PORT;
  if (!port) {
    throw new Error('gateway port is not available (PORT/OPENCLAW_GATEWAY_PORT unset)');
  }
  return `http://127.0.0.1:${port}`;
}

// texts -> one embedding vector per text, same order. Batches in one request
// (the endpoint accepts `input` as a string or array).
async function embed(texts, { pluginRuntime } = {}) {
  if (!pluginRuntime) throw new Error('pluginRuntime is required');
  if (!Array.isArray(texts) || texts.length === 0) {
    throw new Error('texts must be a non-empty array of strings');
  }

  const agentId = getEmbeddingsAgentId();
  const memorySearch = resolveMemorySearchConfig(pluginRuntime, agentId);
  const provider = memorySearch?.provider;
  const model = memorySearch?.model;

  if (!provider || provider === 'none' || !model) {
    throw new Error(
      'memorySearch is not configured for the embeddings agent — recall embeddings are unavailable'
    );
  }

  const token = process.env.OPENCLAW_GATEWAY_TOKEN;
  if (!token) {
    throw new Error('OPENCLAW_GATEWAY_TOKEN is not available');
  }

  const baseUrl = resolveGatewayBaseUrl();

  const res = await fetch(`${baseUrl}/v1/embeddings`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'x-openclaw-model': `${provider}/${model}`,
    },
    body: JSON.stringify({ model: `openclaw/${agentId}`, input: texts }),
  });

  if (!res.ok) {
    const bodyText = await res.text().catch(() => '');
    throw new Error(`embeddings request failed: ${res.status} ${bodyText}`.trim());
  }

  const body = await res.json();
  if (!Array.isArray(body?.data)) {
    throw new Error('embeddings response missing `data` array');
  }

  return body.data.map((entry) => entry.embedding);
}

module.exports = {
  embed,
};

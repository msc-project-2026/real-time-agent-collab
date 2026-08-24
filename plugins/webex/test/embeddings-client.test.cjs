'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { loadWithMocks } = require('./helpers.cjs');

// ---------------------------------------------------------------------------
// embeddings/client.js — thin wrapper around the gateway's own /v1/embeddings
// HTTP endpoint (v3 §9, phase 7). global.fetch is stubbed here; no live
// network call in the suite. Covers the two confirmed-live gotchas
// (x-openclaw-model header shape, memorySearch-missing fail-soft) documented
// in the phase-7 plan's §0 spike notes.
// ---------------------------------------------------------------------------

function withEnv(t, vars) {
  const saved = {};
  for (const key of Object.keys(vars)) {
    saved[key] = process.env[key];
    if (vars[key] === undefined) delete process.env[key];
    else process.env[key] = vars[key];
  }
  t.after(() => {
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });
}

function withFetch(t, impl) {
  const original = global.fetch;
  global.fetch = impl;
  t.after(() => {
    global.fetch = original;
  });
  return impl;
}

function loadClient(t, { getEmbeddingsAgentId } = {}) {
  const loaded = loadWithMocks(require.resolve('../embeddings/client'), {
    [require.resolve('../runtime')]: {
      getEmbeddingsAgentId: getEmbeddingsAgentId ?? (() => 'main'),
    },
  });
  t.after(loaded.restore);
  return loaded.subject;
}

function makePluginRuntime(memorySearch) {
  return {
    config: {
      current: () => ({
        agents: {
          list: [{ id: 'main', memorySearch }],
        },
      }),
    },
  };
}

describe('embeddings/client — embed()', () => {
  test('posts to the gateway\'s own local /v1/embeddings with the confirmed request shape', async (t) => {
    withEnv(t, { PORT: '18789', OPENCLAW_GATEWAY_TOKEN: 'gw-token' });
    const calls = [];
    withFetch(t, async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        json: async () => ({ data: [{ embedding: [0.1, 0.2] }] }),
      };
    });
    const { embed } = loadClient(t);
    const pluginRuntime = makePluginRuntime({
      provider: 'openai',
      model: 'azure/text-embedding-3-small',
    });

    const result = await embed(['hello'], { pluginRuntime });

    assert.deepEqual(result, [[0.1, 0.2]]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'http://127.0.0.1:18789/v1/embeddings');
    assert.equal(calls[0].options.method, 'POST');
    assert.equal(calls[0].options.headers.Authorization, 'Bearer gw-token');
    // The confirmed-live gotcha: provider/model must be sent as this header,
    // not relied on via the config-level model field alone (see the phase-7
    // plan's §0 spike notes for why memorySearch.model alone gets misparsed).
    assert.equal(calls[0].options.headers['x-openclaw-model'], 'openai/azure/text-embedding-3-small');
    const body = JSON.parse(calls[0].options.body);
    // Must target this agent explicitly (openclaw/<agentId>) — the bare
    // "openclaw" shorthand resolves server-side to whichever agent is
    // default: true, which isn't guaranteed to match getEmbeddingsAgentId().
    assert.deepEqual(body, { model: 'openclaw/main', input: ['hello'] });
  });

  test('resolves memorySearch config from getEmbeddingsAgentId(), independent of any routing agent', async (t) => {
    withEnv(t, { PORT: '18789', OPENCLAW_GATEWAY_TOKEN: 'gw-token' });
    withFetch(t, async () => ({
      ok: true,
      json: async () => ({ data: [{ embedding: [0.1] }] }),
    }));
    const { embed } = loadClient(t, { getEmbeddingsAgentId: () => 'embeddings-agent' });
    const pluginRuntime = {
      config: {
        current: () => ({
          agents: {
            list: [
              { id: 'main' }, // no memorySearch here — must not be used
              { id: 'embeddings-agent', memorySearch: { provider: 'openai', model: 'm' } },
            ],
          },
        }),
      },
    };

    await embed(['hello'], { pluginRuntime });
    // No throw — confirms the dedicated embeddings agent id's config (not
    // "main") was actually used.
  });

  test('batches multiple texts in one request, returning one embedding per text in order', async (t) => {
    withEnv(t, { PORT: '18789', OPENCLAW_GATEWAY_TOKEN: 'gw-token' });
    withFetch(t, async () => ({
      ok: true,
      json: async () => ({
        data: [{ embedding: [0.1] }, { embedding: [0.2] }],
      }),
    }));
    const { embed } = loadClient(t);
    const pluginRuntime = makePluginRuntime({ provider: 'openai', model: 'm' });

    const result = await embed(['a', 'b'], { pluginRuntime });

    assert.deepEqual(result, [[0.1], [0.2]]);
  });

  test('throws when memorySearch is not configured for the embeddings agent', async (t) => {
    withEnv(t, { PORT: '18789', OPENCLAW_GATEWAY_TOKEN: 'gw-token' });
    const { embed } = loadClient(t);
    const pluginRuntime = makePluginRuntime({ provider: 'none' });

    await assert.rejects(embed(['hello'], { pluginRuntime }), /memorySearch is not configured/);
  });

  test('throws when memorySearch is entirely absent', async (t) => {
    withEnv(t, { PORT: '18789', OPENCLAW_GATEWAY_TOKEN: 'gw-token' });
    const { embed } = loadClient(t);
    const pluginRuntime = makePluginRuntime(undefined);

    await assert.rejects(embed(['hello'], { pluginRuntime }), /memorySearch is not configured/);
  });

  test('throws a descriptive error when the HTTP call fails', async (t) => {
    withEnv(t, { PORT: '18789', OPENCLAW_GATEWAY_TOKEN: 'gw-token' });
    withFetch(t, async () => ({
      ok: false,
      status: 400,
      text: async () => '{"error":"This agent does not allow that embedding provider"}',
    }));
    const { embed } = loadClient(t);
    const pluginRuntime = makePluginRuntime({ provider: 'openai', model: 'm' });

    await assert.rejects(embed(['hello'], { pluginRuntime }), /embeddings request failed: 400/);
  });

  test('throws when the gateway port is unavailable', async (t) => {
    withEnv(t, { PORT: undefined, OPENCLAW_GATEWAY_PORT: undefined, OPENCLAW_GATEWAY_TOKEN: 'gw-token' });
    const { embed } = loadClient(t);
    const pluginRuntime = makePluginRuntime({ provider: 'openai', model: 'm' });

    await assert.rejects(embed(['hello'], { pluginRuntime }), /gateway port is not available/);
  });
});

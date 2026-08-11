// ********* ROUTING/DIRECT-LLM.JS *********
'use strict';

// Direct LLM call for routing — bypasses OpenClaw agent dispatch so routing
// uses a fixed lightweight model (Gemini Flash) regardless of how the
// gateway agents are configured.

// const ROUTING_MODEL = 'vertex_ai/gemini-2.5-flash';

const ROUTING_MODEL =
  process.env.WEBEX_ROUTING_MODEL ||
  'vertex_ai/gemini-2.5-flash';
  
const ROUTING_MAX_TOKENS = 256;

function resolveProvider(gatewayCfg) {
  const providers = gatewayCfg?.models?.providers ?? {};
  for (const p of Object.values(providers)) {
    if (p.baseUrl && p.apiKey && p.api === 'openai-completions') return p;
  }
  return null;
}

async function callRoutingLlm({ instruction, pluginRuntime, log }) {
  const gatewayCfg = pluginRuntime.config?.current?.() ?? {};
  const provider = resolveProvider(gatewayCfg);

  if (!provider) {
    log?.warn?.('[webex:routing] no OpenAI-compatible provider found; routing skipped');
    return null;
  }

  const baseUrl = provider.baseUrl.replace(/\/?$/, '/');
  const res = await fetch(`${baseUrl}chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${provider.apiKey}`,
    },
    body: JSON.stringify({
      model: ROUTING_MODEL,
      messages: [{ role: 'user', content: instruction }],
      max_tokens: ROUTING_MAX_TOKENS,
      temperature: 0,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`[webex:routing] LLM call failed ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = await res.json();
  return data?.choices?.[0]?.message?.content ?? null;
}

module.exports = { callRoutingLlm };

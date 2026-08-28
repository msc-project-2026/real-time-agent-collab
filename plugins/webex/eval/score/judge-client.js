// ********* EVAL/SCORE/JUDGE-CLIENT.JS *********
'use strict';

// Minimal OpenAI-compatible client for the LLM-as-judge scorers.
//
// Deliberately standalone rather than routed through the gateway: scoring runs
// offline over a downloaded bundle, so it needs no plugin runtime, and keeping
// it out of the gateway means a judge change never risks the live pipeline.
//
// The judge must not be a pipeline identity scoring its own output, so it is
// configured entirely from the environment and defaults to a stronger model
// than the pipeline's Haiku:
//   EVAL_JUDGE_BASE_URL  (e.g. https://llm-proxy.dev.outshift.ai/)
//   EVAL_JUDGE_API_KEY
//   EVAL_JUDGE_MODEL     (default: Sonnet 4.6 via the same proxy)
//
// Every call is appended to judge-log.jsonl next to the bundle, prompt and
// raw response included. An unexplained verdict is not reportable, and the
// log is what makes it possible to audit the judge itself later.

const fs = require('node:fs/promises');

const DEFAULT_MODEL = 'bedrock/global.anthropic.claude-sonnet-4-6';
const DEFAULT_TIMEOUT_MS = 60_000;

function readEnvConfig(env = process.env) {
  const baseUrl = env.EVAL_JUDGE_BASE_URL;
  const apiKey = env.EVAL_JUDGE_API_KEY;
  const model = env.EVAL_JUDGE_MODEL || DEFAULT_MODEL;
  const missing = [];
  if (!baseUrl) missing.push('EVAL_JUDGE_BASE_URL');
  if (!apiKey) missing.push('EVAL_JUDGE_API_KEY');
  return { baseUrl, apiKey, model, missing };
}

// Models wrap JSON in prose or fences often enough that a bare JSON.parse is
// not a safe contract. Falls back to the outermost {...} span.
function parseJsonLoose(text) {
  const raw = String(text ?? '').trim();
  try {
    return JSON.parse(raw);
  } catch {
    /* fall through */
  }
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) {
    try {
      return JSON.parse(fenced[1]);
    } catch {
      /* fall through */
    }
  }
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(raw.slice(start, end + 1));
    } catch {
      /* fall through */
    }
  }
  return null;
}

function createJudge({ logPath, env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const config = readEnvConfig(env);
  const calls = [];

  async function log(entry) {
    calls.push(entry);
    if (!logPath) return;
    await fs
      .appendFile(logPath, `${JSON.stringify(entry)}\n`, 'utf8')
      .catch(() => {});
  }

  // Returns { ok, verdict, raw, error }. Never throws: one failed judgement
  // must not abandon a scoring run that may contain dozens of them.
  async function judge({ kind, system, user, temperature = 0 }) {
    if (config.missing.length > 0) {
      const error = `missing env: ${config.missing.join(', ')}`;
      await log({ at: new Date().toISOString(), kind, ok: false, error });
      return { ok: false, verdict: null, raw: null, error };
    }

    const url = `${config.baseUrl.replace(/\/$/, '')}/chat/completions`;
    const body = {
      model: config.model,
      temperature,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    };

    let lastError = null;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const res = await fetchImpl(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${config.apiKey}`,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
        });
        if (!res.ok) {
          lastError = `HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`;
          continue;
        }
        const payload = await res.json();
        const raw = payload?.choices?.[0]?.message?.content ?? '';
        const verdict = parseJsonLoose(raw);
        const entry = {
          at: new Date().toISOString(),
          kind,
          model: config.model,
          attempt,
          ok: Boolean(verdict),
          system,
          user,
          raw,
          verdict,
          usage: payload?.usage ?? null,
        };
        await log(entry);
        if (!verdict) {
          lastError = 'judge response was not parseable JSON';
          continue;
        }
        return { ok: true, verdict, raw, error: null };
      } catch (err) {
        lastError = err?.message ?? String(err);
      }
    }

    await log({ at: new Date().toISOString(), kind, ok: false, error: lastError });
    return { ok: false, verdict: null, raw: null, error: lastError };
  }

  return { judge, config, calls };
}

module.exports = { createJudge, readEnvConfig, parseJsonLoose, DEFAULT_MODEL };

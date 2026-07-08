// Out-of-band store for env-file content so secrets never travel through an LLM
// prompt. When a deployment is requested with an env file, the content is
// stashed here keyed by app name; the deploy tool pulls it at the CLI boundary
// (piped over stdin to deploy-cli) and consumes it. Entries expire so a stashed
// secret does not linger if a deploy is never carried out.
'use strict';

const TTL_MS = 10 * 60 * 1000;
const store = new Map(); // name -> { content, expiresAt }

function set(name, content) {
  if (!name || typeof content !== 'string' || content.trim() === '') return;
  store.set(String(name), { content, expiresAt: Date.now() + TTL_MS });
}

// take returns and removes the stashed content for name, or '' if none/expired.
function take(name) {
  const key = String(name);
  const entry = store.get(key);
  if (!entry) return '';
  store.delete(key);
  if (Date.now() > entry.expiresAt) return '';
  return entry.content;
}

// sweep drops expired entries; cheap to call opportunistically.
function sweep() {
  const now = Date.now();
  for (const [k, v] of store) {
    if (now > v.expiresAt) store.delete(k);
  }
}

module.exports = { set, take, sweep };

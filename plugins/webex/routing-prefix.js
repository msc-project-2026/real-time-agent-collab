'use strict';

// Backstop for the Webex reply channel.
//
// The routing/classification decision is now reported through the
// `collab_route_decision` tool call (see tools/route-decision.js), so the
// agent's visible text should be the human reply only. This helper is the
// defense-in-depth guard: if a model ever still prepends a routing-decision
// object like {"route":"...","reason":"...","claimedBatch":{...}} to its reply,
// we separate it out here so it never reaches the Webex space.
//
// It is a pure function and never throws. It returns:
//   { route, reply }
// where `route` is the routing label if a leading control object was found
// (for logging), otherwise null; and `reply` is the human-readable text to
// send (possibly empty, meaning "send nothing").
function extractRoutingPrefix(text) {
  const input = String(text ?? '');
  // Tolerate the control object being wrapped in a leading ```json fence.
  const s = input.replace(/^\s*```(?:json)?\s*/i, '').trimStart();
  if (!s.startsWith('{')) return { route: null, reply: input.trim() };

  // Walk balanced braces while skipping string contents, so braces inside a
  // "reason" value cannot throw off the depth count.
  let depth = 0;
  let inStr = false;
  let esc = false;
  let end = -1;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }

  // Unterminated object. Only suppress it when it actually looks like a partial
  // routing artifact (e.g. a truncated `{"route": ...`); otherwise it is far
  // more likely a legitimate reply that merely opens with a brace, so send it
  // verbatim rather than silently dropping a human message.
  if (end === -1) {
    if (/^\{\s*"route"\s*:/.test(s)) return { route: null, reply: '' };
    return { route: null, reply: input.trim() };
  }

  let parsed;
  try {
    parsed = JSON.parse(s.slice(0, end));
  } catch {
    // Leading brace but not valid JSON — likely a legitimate reply (e.g. a code
    // snippet). Send it verbatim.
    return { route: null, reply: input.trim() };
  }

  // Valid JSON but not a routing decision (again, could be a real reply that
  // happens to be a JSON object). Send it verbatim.
  if (!parsed || typeof parsed.route !== 'string') {
    return { route: null, reply: input.trim() };
  }

  // A routing-decision object slipped into the text stream. Strip it and drop a
  // trailing code fence if the object was fenced.
  const rest = s.slice(end).replace(/^\s*```/, '').trim();
  return { route: parsed.route, reply: rest };
}

module.exports = { extractRoutingPrefix };

'use strict';

// Vendored from the retired plugins/webex proactivity pipeline (kept here so
// the plugin stays copy-portable).
// Lightweight Haiku gate: classifies and scores whether the main agent should respond.
//
// Returns { score: 0.0–1.0, type: InterventionType }.
// The caller maps `type` to a per-type threshold (configured in openclaw.json) so
// the sensitivity bar differs by intervention category — e.g. factual corrections
// fire at 0.4 while unsolicited elaborations need 0.75.
//
// On any failure the result defaults to { score: 0.0, type: 'NONE' } (fail-silent).

// The intervention types (DiscussLLM taxonomy, Patel et al. 2025, plus ADDRESSED):
//   ADDRESSED          — the message speaks directly to the assistant
//   FACTUAL_CORRECTION — someone states something incorrect
//   BLOCKER            — someone is stuck / explicitly blocked
//   CLARIFICATION      — an open question or ambiguity that can be answered
//   ELABORATION        — assistant could usefully deepen the discussion
//   NONE               — banter, ack, off-topic, noise

const VALID_TYPES = new Set([
  'ADDRESSED',
  'FACTUAL_CORRECTION',
  'BLOCKER',
  'CLARIFICATION',
  'ELABORATION',
  'NONE',
]);

function buildGatePrompt({ text, senderName, chatType, recentMessages, botNamed, addressNames }) {
  const ctx = chatType === 'direct' ? 'a direct message' : 'a group channel';

  const historyBlock =
    recentMessages.length > 0
      ? [
          'Recent conversation (oldest → newest):',
          ...recentMessages.map((m) => `  ${m.senderName}: "${m.text}"`),
          '',
        ].join('\n')
      : '';

  const botNamedBlock = botNamed
    ? [
        `Note: the latest message contains one of the assistant's names (${(addressNames ?? []).join(', ')}).`,
        'If the message is speaking TO the assistant — a question, request, or greeting directed',
        'at it — classify it as ADDRESSED with a high score, even if it is casual chatter.',
        'If it merely talks ABOUT assistants/agents/AI in general, do not use ADDRESSED.',
        '',
      ].join('\n')
    : '';

  return [
    'You are a relevance classifier for a software engineering team\'s AI assistant.',
    'Classify the latest message and score whether the assistant would add genuine value by responding.',
    '',
    'Intervention types:',
    '  ADDRESSED          — the message speaks directly to the assistant (names it or asks it to act)',
    '  FACTUAL_CORRECTION — someone states something factually wrong',
    '  BLOCKER            — someone is stuck or explicitly blocked on something',
    '  CLARIFICATION      — an unanswered question or genuine ambiguity',
    '  ELABORATION        — assistant could usefully add context or nuance (high bar)',
    '  NONE               — greetings, thanks, banter, off-topic, ambient chatter',
    '',
    'Score (0.0–1.0): how confident you are that responding adds value for this type.',
    '  0.0 = no value   0.5 = borderline   1.0 = strong signal',
    '',
    'Output exactly one line in this format (nothing else):',
    'TYPE|score',
    'Example: CLARIFICATION|0.72',
    '',
    botNamedBlock,
    historyBlock,
    `Latest message from ${senderName} in ${ctx}:`,
    `"${String(text ?? '').slice(0, 500)}"`,
  ].join('\n');
}

// gateCfg: { url, model, apiKey }
// messageCtx: { text, senderName, chatType, recentMessages }
async function scoreMessage(messageCtx, gateCfg) {
  const { url, model, apiKey } = gateCfg ?? {};
  if (!apiKey || !url || !model) return { score: 0.0, type: 'NONE' };

  const prompt = buildGatePrompt(messageCtx);

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 20,
        temperature: 0,
      }),
    });
  } catch {
    return { score: 0.0, type: 'NONE' };
  }

  if (!res.ok) return { score: 0.0, type: 'NONE' };

  let data;
  try {
    data = await res.json();
  } catch {
    return { score: 0.0, type: 'NONE' };
  }

  const raw = String(data?.choices?.[0]?.message?.content ?? '').trim();

  // Parse "TYPE|score" — be lenient with whitespace
  const match = raw.match(/^([A-Z_]+)\s*[|]\s*(\d+(?:\.\d+)?)$/i);
  if (!match) return { score: 0.0, type: 'NONE' };

  const type = match[1].toUpperCase();
  const score = Math.min(1.0, Math.max(0.0, parseFloat(match[2])));

  return {
    score,
    type: VALID_TYPES.has(type) ? type : 'NONE',
  };
}

module.exports = { scoreMessage };

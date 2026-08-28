// ********* EVAL/SCORE/SCORE-GATE.JS *********
'use strict';

// Deterministic scoring of the tagging gate: its two outputs are booleans,
// so there is nothing here an LLM judge could add.
//
// Ground truth comes from the scenario's per-message `expectedTags`; observed
// values come from the gate's own audit log (`tagging/validation.jsonl`,
// bundled as `gateValidation`), not from any downstream effect — a gate
// decision that was correct but whose consequence was later overridden should
// still score as correct.
//
// `sliceReady` is deliberately not scored. It answers "has the conversation
// settled", which is a temporal question the gate cannot answer from a static
// snapshot, so there is no defensible ground truth to compare against. It is
// reported as an observed rate instead.

const FIELDS = ['isAddressed', 'configRequest'];

function emptyConfusion() {
  return { truePositive: 0, trueNegative: 0, falsePositive: 0, falseNegative: 0 };
}

function record(confusion, expected, observed) {
  if (expected && observed) confusion.truePositive += 1;
  else if (!expected && !observed) confusion.trueNegative += 1;
  else if (!expected && observed) confusion.falsePositive += 1;
  else confusion.falseNegative += 1;
}

function accuracy(confusion) {
  const total =
    confusion.truePositive +
    confusion.trueNegative +
    confusion.falsePositive +
    confusion.falseNegative;
  if (total === 0) return null;
  return (confusion.truePositive + confusion.trueNegative) / total;
}

// bundle: the object written by eval/run-scenario.js.
// Returns { messages: [...per-message rows], byField: {...}, overall: {...} }.
function scoreGate(bundle) {
  const scenario = bundle?.scenario ?? {};
  const messages = Array.isArray(scenario.messages) ? scenario.messages : [];
  const validation = Array.isArray(bundle?.gateValidation) ? bundle.gateValidation : [];

  // One gate run per message; keyed by the message it judged. A message the
  // gate never ran on is a real failure (the flow died before the gate), so
  // it is reported as `missing` rather than skipped.
  const byMessageId = new Map();
  for (const entry of validation) {
    if (entry?.messageId) byMessageId.set(entry.messageId, entry);
  }

  const scenarioId = scenario.id ?? 'unknown';
  const byField = Object.fromEntries(FIELDS.map((f) => [f, emptyConfusion()]));
  const rows = [];
  let missing = 0;
  let sliceReadyTrue = 0;
  let sliceReadySeen = 0;

  for (const message of messages) {
    const expected = message?.expectedTags;
    if (!expected) continue;

    const messageId = `${scenarioId}-msg-${message.number}`;
    const entry = byMessageId.get(messageId);

    if (!entry) {
      missing += 1;
      rows.push({ number: message.number, messageId, missing: true });
      continue;
    }

    const observedTags = entry.messageTags ?? {};
    const row = { number: message.number, messageId, fields: {} };

    for (const field of FIELDS) {
      const exp = Boolean(expected[field]);
      const obs = Boolean(observedTags[field]);
      record(byField[field], exp, obs);
      row.fields[field] = { expected: exp, observed: obs, correct: exp === obs };
    }

    row.correct = FIELDS.every((f) => row.fields[f].correct);
    row.reason = entry.pendingThreadWindowDecision?.reason ?? null;
    rows.push(row);

    sliceReadySeen += 1;
    if (entry.pendingThreadWindowDecision?.sliceReady) sliceReadyTrue += 1;
  }

  const scored = rows.filter((r) => !r.missing);
  const overall = {
    messagesScored: scored.length,
    messagesMissingGateRun: missing,
    fullyCorrect: scored.filter((r) => r.correct).length,
    accuracy: scored.length ? scored.filter((r) => r.correct).length / scored.length : null,
    // Observed only — see the header note on why this is not scored.
    sliceReadyRate: sliceReadySeen ? sliceReadyTrue / sliceReadySeen : null,
  };

  return {
    messages: rows,
    byField: Object.fromEntries(
      FIELDS.map((f) => [f, { ...byField[f], accuracy: accuracy(byField[f]) }])
    ),
    overall,
  };
}

module.exports = { scoreGate, FIELDS };

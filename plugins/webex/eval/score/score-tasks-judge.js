// ********* EVAL/SCORE/SCORE-TASKS-JUDGE.JS *********
'use strict';

// LLM-judged fidelity of an extracted task's free text.
//
// score-tasks.js has already decided *which* observed task corresponds to
// which expected one, using message-id evidence. This step judges only the
// remainder that cannot be compared mechanically: whether the title and
// description the model wrote are a faithful account of the conversation, or
// whether they drift, invent detail, or describe something narrower or
// broader than what was actually said.
//
// The conversation is the ground truth, not the fixture's title — that title
// is one valid phrasing, and judging against it would penalise correct
// paraphrases.

const SYSTEM = `You evaluate whether a task extracted from a chat conversation faithfully represents that conversation.

You are given the whole conversation, with the messages the extracted task cites as its evidence marked. You are also given the extracted task and a reference title written by a human describing what the task should capture.

The extraction step could see the whole conversation, so detail drawn from surrounding messages is legitimate, not invention — judge against the conversation as a whole, not only the cited lines. Different wording from the reference title is fine; it is one valid phrasing, not the only one.

Fail only when the extracted task:
- states something no message in the conversation supports, or
- describes work materially narrower or broader than what was discussed, or
- is so vague that a reader could not tell what to do.

Respond with JSON only, no prose:
{"verdict": "pass" | "fail", "rationale": "<one or two sentences>"}`;

function buildUserPrompt({ conversation, citedNumbers, observedTitle, observedDescription, referenceTitle }) {
  const cited = new Set(citedNumbers ?? []);
  const transcript = conversation
    .map((m) => `${cited.has(m.number) ? '->' : '  '} [${m.number}] ${m.sender}: ${m.text}`)
    .join('\n');

  return `Conversation (-> marks the messages this task cites as evidence):
${transcript || '(empty)'}

Extracted task:
  title: ${observedTitle ?? '(none)'}
  description: ${observedDescription ?? '(none)'}

Reference title (one acceptable phrasing):
  ${referenceTitle ?? '(none)'}`;
}

// The whole script. The extraction step read the full thread window, so a
// judge shown only the cited messages penalises the model for context it
// legitimately had: the first live judge run failed a task for "inventing"
// the words "reporting dashboard" and "Thursday's demo", both of which are
// verbatim in message 1 — a message the judge was never shown.
function conversationFor(bundle) {
  return Array.isArray(bundle?.scenario?.messages) ? bundle.scenario.messages : [];
}

// Cited evidence ids back to their script line numbers, for the -> markers.
function citedNumbersFor(bundle, messageIds) {
  const scenarioId = bundle?.scenario?.id ?? 'unknown';
  const wanted = new Set(messageIds ?? []);
  return conversationFor(bundle)
    .filter((m) => wanted.has(`${scenarioId}-msg-${m.number}`))
    .map((m) => m.number);
}

// taskScore: the output of score-tasks.js. judge: from createJudge().
async function scoreTasksJudge({ bundle, taskScore, judge }) {
  const results = [];

  const conversation = conversationFor(bundle);

  for (const pair of taskScore?.matched ?? []) {
    // Markers show what the model actually cited, not what the fixture
    // expected — a stray citation is itself a fidelity signal.
    const citedNumbers = citedNumbersFor(bundle, pair.observedMessageIds);

    const { ok, verdict, error } = await judge({
      kind: 'task-fidelity',
      system: SYSTEM,
      user: buildUserPrompt({
        conversation,
        citedNumbers,
        observedTitle: pair.observedTitle,
        observedDescription: pair.observedDescription,
        referenceTitle: pair.expectedTitle,
      }),
    });

    results.push({
      expectedId: pair.expectedId,
      observedId: pair.observedId,
      observedTitle: pair.observedTitle,
      judged: ok,
      verdict: ok ? verdict.verdict ?? null : null,
      rationale: ok ? verdict.rationale ?? null : null,
      error: ok ? null : error,
    });
  }

  const judged = results.filter((r) => r.judged);
  const passed = judged.filter((r) => r.verdict === 'pass');

  return {
    results,
    overall: {
      pairs: results.length,
      judged: judged.length,
      unjudged: results.length - judged.length,
      passed: passed.length,
      passRate: judged.length ? passed.length / judged.length : null,
    },
  };
}

module.exports = { scoreTasksJudge, buildUserPrompt, conversationFor, citedNumbersFor, SYSTEM };

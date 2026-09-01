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

// Frozen for calibration. The grader packs under plugins/webex/calibration/
// were built against this exact prompt, and an agreement figure only describes
// the prompt it was measured on — editing SYSTEM silently invalidates every
// number the calibration produced. test/judge-prompt-freeze.test.cjs pins the
// prompt's hash, so any edit fails the suite until this version is bumped and
// the calibration is redone or explicitly declared still applicable.
const PROMPT_VERSION = 'task-fidelity/v1 (2026-08-29)';

const SYSTEM = `You evaluate whether a task extracted from a chat conversation faithfully represents that conversation.

You are given the whole conversation, with the messages the extracted task cites as its evidence marked. You are also given the extracted task and a reference title written by a human describing what the task should capture.

The extraction step could see the whole conversation, so detail drawn from surrounding messages is legitimate, not invention — judge against the conversation as a whole, not only the cited lines. Different wording from the reference title is fine; it is one valid phrasing, not the only one.

Rate the extracted task from 1 to 4:

4 - Accurately describes the work and is appropriately scoped.
3 - Accurate, but vague or with a minor scope issue.
2 - A notable inaccuracy: states something the conversation does not support, or omits a key element of what was actually asked for.
1 - Fabricated: describes work the conversation never discusses.

Rate only the extracted text against the conversation. Who the task is assigned to is checked separately and is not yours to judge.

Respond with JSON only, no prose:
{"rating": 1 | 2 | 3 | 4, "rationale": "<one or two sentences>"}`;

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

// Ratings are reported as a distribution, never collapsed to pass/fail: any
// threshold would be an arbitrary line, and nothing in the pipeline acts on
// the judge's output. Keeping the scale also lets calibration surface
// systematic bias (a judge running consistently harsher than a human) rather
// than only bare disagreement.
function normaliseRating(value) {
  return Number.isInteger(value) && value >= 1 && value <= 4 ? value : null;
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
      rating: ok ? normaliseRating(verdict.rating) : null,
      rationale: ok ? verdict.rationale ?? null : null,
      error: ok ? null : error,
    });
  }

  // A rating that came back outside 1-4 counts as unjudged rather than
  // being clamped into a neighbouring band: a malformed rating is a judge
  // failure, and quietly rounding it would hide that in the distribution.
  const judged = results.filter((r) => r.judged && r.rating !== null);
  const distribution = { 1: 0, 2: 0, 3: 0, 4: 0 };
  for (const r of judged) distribution[r.rating] += 1;

  return {
    results,
    overall: {
      pairs: results.length,
      judged: judged.length,
      unjudged: results.length - judged.length,
      distribution,
      mean: judged.length
        ? judged.reduce((sum, r) => sum + r.rating, 0) / judged.length
        : null,
    },
  };
}

module.exports = {
  scoreTasksJudge,
  buildUserPrompt,
  conversationFor,
  citedNumbersFor,
  normaliseRating,
  SYSTEM,
  PROMPT_VERSION,
};

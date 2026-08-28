// ********* EVAL/SCORE/SCORE-TASKS-JUDGE.JS *********
'use strict';

// LLM-judged fidelity of an extracted task's free text.
//
// score-tasks.js has already decided *which* observed task corresponds to
// which expected one, using message-id evidence. This step judges only the
// remainder that cannot be compared mechanically: whether the title and
// description the model wrote are a faithful account of the source messages,
// or whether they drift, invent detail, or describe something narrower or
// broader than what was actually said.
//
// The judge is given the source messages verbatim, not the expected title, as
// the primary ground truth — the fixture's title is one valid phrasing, not
// the only one, and judging against it would penalise correct paraphrases.

const SYSTEM = `You evaluate whether a task extracted from a chat conversation faithfully represents its source messages.

You are given the source messages, the task an automated system extracted from them, and a reference title written by a human describing what the task should capture.

Judge only faithfulness to the source messages. Different wording from the reference title is fine — it is one valid phrasing, not the only one. Judge harshly only when the extracted task:
- states something the source messages do not support (invented detail), or
- describes work materially narrower or broader than what was discussed, or
- is so vague that a reader could not tell what to do.

Respond with JSON only, no prose:
{"verdict": "pass" | "fail", "score": <0-1>, "rationale": "<one or two sentences>"}`;

function buildUserPrompt({ sourceMessages, observedTitle, observedDescription, referenceTitle }) {
  const transcript = sourceMessages
    .map((m) => `[${m.number}] ${m.sender}: ${m.text}`)
    .join('\n');

  return `Source messages:
${transcript || '(none found for the cited evidence ids)'}

Extracted task:
  title: ${observedTitle ?? '(none)'}
  description: ${observedDescription ?? '(none)'}

Reference title (one acceptable phrasing):
  ${referenceTitle ?? '(none)'}`;
}

// Resolves the cited evidence ids back to the scenario's own script lines, so
// the judge sees what was actually said rather than an id list.
function resolveSourceMessages(bundle, messageIds) {
  const scenario = bundle?.scenario ?? {};
  const scenarioId = scenario.id ?? 'unknown';
  const wanted = new Set(messageIds ?? []);
  return (scenario.messages ?? []).filter((m) =>
    wanted.has(`${scenarioId}-msg-${m.number}`)
  );
}

// taskScore: the output of score-tasks.js. judge: from createJudge().
async function scoreTasksJudge({ bundle, taskScore, judge }) {
  const results = [];

  for (const pair of taskScore?.matched ?? []) {
    // Union of both sides' evidence: if the model cited a message the fixture
    // did not expect, the judge should see it — that extra citation is often
    // exactly what makes an extraction unfaithful.
    const ids = [
      ...new Set([...(pair.observedMessageIds ?? []), ...(pair.expectedMessageIds ?? [])]),
    ];
    const sourceMessages = resolveSourceMessages(bundle, ids);

    const { ok, verdict, error } = await judge({
      kind: 'task-fidelity',
      system: SYSTEM,
      user: buildUserPrompt({
        sourceMessages,
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
      score: ok ? verdict.score ?? null : null,
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
      meanScore: judged.length
        ? judged.reduce((sum, r) => sum + (typeof r.score === 'number' ? r.score : 0), 0) /
          judged.length
        : null,
    },
  };
}

module.exports = { scoreTasksJudge, buildUserPrompt, resolveSourceMessages, SYSTEM };

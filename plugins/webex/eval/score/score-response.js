// ********* EVAL/SCORE/SCORE-RESPONSE.JS *********
'use strict';

// LLM-judged quality of the respond step's replies.
//
// A scenario's `recallChecks` name the question turns and the facts a correct
// answer has to convey. Those facts are deliberately not exact strings: many
// phrasings answer a question correctly, so this is judged rather than matched.
//
// Scored on the same 1-4 anchored scale as task fidelity, so one calibration
// protocol covers both judges and a human grader learns one rubric shape.
//
// This could not run at all until the outbound override landed (send.js): the
// respond step's reply goes out through the model's own `message` tool, which
// no injected `sendFn` could reach, so no reply text ever reached the bundle.

// Frozen for calibration — see the same note in score-tasks-judge.js. The
// version is stamped independently of the task judge's because the two are
// separate prompts with separate agreement numbers; one can be revised
// without invalidating the other.
const PROMPT_VERSION = 'response-quality/v1 (2026-08-29)';

const SYSTEM = `You evaluate whether an assistant's reply in a team chat correctly answers the question it was asked.

You are given the conversation up to and including the question, the assistant's reply, and the facts a correct answer needs to convey. Those facts are a checklist of substance, not required wording — any phrasing that conveys them is correct.

Rate the reply from 1 to 4:

4 - Answers the question, conveys the expected facts, and states nothing the conversation does not support.
3 - Answers it, with a minor omission or a minor unsupported detail.
2 - Misses a key expected fact, or states something the conversation contradicts.
1 - Does not answer the question, or is substantially fabricated.

Judge only the reply's content against the conversation. Tone, length and formatting are not yours to judge.

Respond with JSON only, no prose:
{"rating": 1 | 2 | 3 | 4, "rationale": "<one or two sentences>"}`;

function buildUserPrompt({ conversation, questionNumber, reply, expectedPoints }) {
  const transcript = conversation
    .map((m) => `${m.number === questionNumber ? '->' : '  '} [${m.number}] ${m.sender}: ${m.text}`)
    .join('\n');

  const points = (expectedPoints ?? []).map((p) => `- ${p}`).join('\n');

  return `Conversation (-> marks the question being answered):
${transcript || '(empty)'}

The assistant's reply:
${reply || '(no reply was sent)'}

Facts a correct answer needs to convey:
${points || '(none specified)'}`;
}

// Replies are attributed to a question by the message number the harness was
// processing when the send happened (`forMessageNumber`), not by parsing the
// reply — the pipeline can emit several sends for one message (a thinking
// placeholder, a task card, then the reply), so the last non-card send for
// that message is the answer.
function replyForQuestion(sends, questionNumber) {
  const candidates = (sends ?? []).filter(
    (s) => s.forMessageNumber === questionNumber && !s.isCard
  );
  if (candidates.length === 0) return null;
  return candidates[candidates.length - 1];
}

async function scoreResponse({ bundle, judge }) {
  const scenario = bundle?.scenario ?? {};
  const conversation = Array.isArray(scenario.messages) ? scenario.messages : [];
  const checks = Array.isArray(scenario.recallChecks) ? scenario.recallChecks : [];
  const sends = Array.isArray(bundle?.sends) ? bundle.sends : [];

  const results = [];

  for (const check of checks) {
    const questionNumber = check.questionMessageNumber;
    const send = replyForQuestion(sends, questionNumber);

    // No reply at all is a real, scoreable failure, not a skip: the agent was
    // asked a direct question and said nothing.
    if (!send) {
      results.push({
        questionNumber,
        replied: false,
        judged: true,
        rating: 1,
        rationale: 'No reply was sent for this question.',
        error: null,
      });
      continue;
    }

    const { ok, verdict, error } = await judge({
      kind: 'response-quality',
      system: SYSTEM,
      user: buildUserPrompt({
        // Only what the agent could have seen when it answered.
        conversation: conversation.filter((m) => m.number <= questionNumber),
        questionNumber,
        reply: send.markdown,
        expectedPoints: check.expectedAnswerPoints,
      }),
    });

    const rating =
      ok && Number.isInteger(verdict.rating) && verdict.rating >= 1 && verdict.rating <= 4
        ? verdict.rating
        : null;

    results.push({
      questionNumber,
      replied: true,
      reply: send.markdown,
      judged: rating !== null,
      rating,
      rationale: ok ? verdict.rationale ?? null : null,
      error: ok ? null : error,
    });
  }

  const judged = results.filter((r) => r.judged && r.rating !== null);
  const distribution = { 1: 0, 2: 0, 3: 0, 4: 0 };
  for (const r of judged) distribution[r.rating] += 1;

  return {
    results,
    overall: {
      questions: results.length,
      judged: judged.length,
      unjudged: results.length - judged.length,
      unanswered: results.filter((r) => !r.replied).length,
      distribution,
      mean: judged.length
        ? judged.reduce((sum, r) => sum + r.rating, 0) / judged.length
        : null,
    },
  };
}

module.exports = { scoreResponse, buildUserPrompt, replyForQuestion, SYSTEM, PROMPT_VERSION };

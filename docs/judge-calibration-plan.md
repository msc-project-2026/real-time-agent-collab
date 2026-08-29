# Judge Calibration Plan

Planning document. Not started. Written 2026-08-28, after the LLM-as-judge task-fidelity
scorer's first live run.

## Why

`eval/score/score-tasks-judge.js` decides whether an extracted task's free text faithfully
represents the conversation it came from. Its ratings feed the report. An unvalidated judge
is an unvalidated instrument: a rating it produces means nothing until we know how well it
agrees with a human on the same inputs.

This matters more than usual here because the judge's **first live run produced a wrong
rating** — it failed a task for "inventing" the words *reporting dashboard* and *Thursday's
demo*, both verbatim in a message the harness never showed it. That bug is fixed (the judge now
receives the whole conversation with cited messages marked), but it establishes that the judge
can be confidently wrong, and that we cannot tell without checking.

## What is being calibrated

**Two judges, each answering one narrow question.**

1. **Task fidelity** (`score-tasks-judge.js`) — given a conversation and a task extracted from
   it, is the task's title and description a faithful account of that conversation?
2. **Response quality** (`score-response.js`) — given a conversation, a question put to the
   agent, and the agent's reply, does the reply answer it and convey the facts a correct answer
   needs?

Deliberately **not** in scope for either:
- *Which* observed task corresponds to which expected task — deterministic, done by
  `message_ids` overlap in `score-tasks.js`, upstream of the judge.
- Gate tagging, field accuracy, update hits, ownership — all deterministic.

### One delegation, two measurements

They share a rubric *shape* (1-4, anchored) but are **separate instruments with separate
prompts**. Agreement on one says nothing about the other, so they need their own agreement
numbers and their own disagreement reviews.

That is a reason to report separately, not to delegate twice: one grader, one onboarding, one
protocol. Two deliveries would double the setup cost for no gain.

**Grade them in separate blocks, not interleaved** — all task examples, then all response
examples. Switching rubrics example-to-example is a reliable way to introduce grader error that
looks like judge disagreement.

This narrowness is what makes calibration tractable and what makes the result durable: changing
the extraction prompt changes the *distribution* of what gets judged, not the judge's task. So
a calibration done now survives later pipeline changes.

## Stability: what must be frozen first

The calibration is invalid if the judge prompt changes afterwards. Freeze, with a version stamp
in the file, before generating the set:

- `SYSTEM` in `eval/score/score-tasks-judge.js` (the rubric)
- `buildUserPrompt` (conversation with `->` cited markers, task, reference title)
- The rating schema: `{rating: 1-4, rationale}`

Already settled, and worth recording as decisions rather than reopening:
- **The conversation is ground truth, not the fixture title.** The fixture title is offered as
  "one acceptable phrasing" so a correct paraphrase is not penalised.
- **The judge sees the whole conversation**, not only cited messages, because the extraction
  step did too.
- **Markers reflect what the model actually cited**, not what the fixture expected — a stray
  citation is itself a fidelity signal.
- **A 4-point anchored scale, not a free 0-1 score and not pass/fail.** A bare float was tried
  and removed the same day: nothing consumed it and its first live use returned `fail` alongside
  `0.7`. An anchored scale is a different instrument — the model picks among written categories
  rather than estimating a continuous quantity, the same reason the pipeline's `confidence`
  float became a `claim` band. Four points, not five, so there is no midpoint for a grader to
  park ambiguous cases in.

    ```
    4 - Accurately describes the work and is appropriately scoped.
    3 - Accurate, but vague or with a minor scope issue.
    2 - A notable inaccuracy: states something the conversation does not support,
        or omits a key element of what was actually asked for.
    1 - Fabricated: describes work the conversation never discusses.
    ```

- **No threshold, no pass/fail.** Ratings are reported as a distribution and a mean. Any cutoff
  would be an arbitrary line, and nothing in the pipeline acts on the judge's output. Keeping
  the scale also lets calibration surface *systematic bias* — a judge running consistently
  harsher than the human — rather than only bare disagreement.
- **Fabrication stays its own band** even though real runs will rarely produce one. "The system
  never fabricated a task" is a specific, checkable claim about the headline risk of an
  extraction system; merged into "inaccurate" it degrades to "n extractions were inaccurate".
- **Ownership is out of scope for the judge.** `assigneeId` is scored deterministically, so
  putting it in the rubric would count the same error twice and blend field correctness into a
  text-fidelity number.
- **Missed tasks are out of scope for the judge.** It only ever sees *matched* pairs; a missed
  task has no extracted text to rate and is already counted as `missing` by `score-tasks.js`.

### Prerequisites before delegating

1. One clean live run with the fixed judge, confirming sane ratings. It has run live exactly
   once, and that run exposed a harness bug.
2. **Self-consistency check** (do this ourselves, not delegated): run the judge 3x on identical
   inputs and confirm the rating is stable. Temperature 0 reduces variance but does not
   guarantee determinism, and a judge that disagrees with itself cannot be calibrated against
   anyone. Note that adjacent bands (3 vs 4) are a likelier wobble than a binary flip ever was,
   so this must be re-run after any rubric change, not treated as a one-off.
3. Freeze and version-stamp the prompt.

## Set composition — the part that decides whether this is worth doing

**Size is secondary; composition is everything.** 30 real extractions would nearly all sit at
4, agreement would land near 95%, and we would have learned nothing: high agreement on easy
cases is not evidence of a good judge. Calibration is only informative where the bands meet.

**Task fidelity: ~24 examples. Response quality: ~16.** Response gets fewer because there are
only three real question turns in the whole scenario set (s00 msg 7; s01 msgs 22 and 25), so it
leans harder on constructed cases — which is acceptable, since constructed ground truth is
stronger than a human label anyway.

Each set, roughly in thirds:

| Portion | Source | What it tests |
|---|---|---|
| ~1/3 | Real extractions, unmodified | Realistic base rate; needs blind human grading |
| ~1/3 | Perturbed to be wrong in exactly one way | Does the judge catch each failure mode? |
| ~1/3 | Perturbed but still correct | **False positives: is the judge too harsh?** |

The third row is the one usually skipped, and it is precisely where the real bug lived — the
judge failed a *correct* extraction. Without those cases, calibration would have called the
judge fine.

Perturbations map onto the rubric's lower bands, so they can be authored without the codebase.
The expected rating in brackets is what the judge should return if it is working:

- **Invented detail** (should rate 1-2) — add a deadline, component, or owner the conversation never
  mentions.
- **Wrong scope** (should rate 2-3) — narrow ("fix the export button tooltip") or broaden
  ("overhaul the export system").
- **Too vague** (should rate 3) — "improve the dashboard".
- **Legitimate paraphrase** (should rate 4) — same work, different vocabulary.
- **Correct use of uncited context** (should rate 4) — detail drawn from a message the task did
  not cite but which is in the conversation. This is the exact case the harness bug got wrong.

### Response-quality perturbations

Same idea, applied to the reply rather than the task:

- **Omits a key fact** (should rate 2) — drop one of the `expectedAnswerPoints` from an
  otherwise good reply.
- **Unsupported claim** (should rate 2) — add a status, owner or deadline the conversation never
  established.
- **Non-answer** (should rate 1) — a fluent reply that never addresses the question.
- **Too vague to land** (should rate 2) — names the topics without conveying either point, e.g.
  "there are a few things left, mainly permissions and the export". Vagueness is graded by
  whether the point actually reaches the asker: still usable is 3, not usable is 2.
- **Different phrasing, same facts** (should rate 4) — the false-positive control.

For constructed cases the ground truth is known by construction, which is stronger than a human
label. Only the real extractions and real replies need blind human grading.

### Where the real examples come from

Both scenarios are on the current fixture schema as of 2026-08-29.

| Scenario | Task pairs / run | Question turns / run |
|---|---|---|
| `eval-s00-smoke` | 2 | 1 |
| `eval-s01-release-readiness` | 5 | 2 |

Three runs of each gives ~21 task pairs and ~9 replies, with natural wording variation between
runs — enough real material for both sets, with the rest constructed.

Generate them with:

```
# per run, on the deployment
node openclaw.mjs gateway call webex.eval.run \
  --params '{"scenarioId":"eval-s01-release-readiness"}' --timeout 900000 --json

# then, offline, over each bundle
EVAL_JUDGE_BASE_URL=... EVAL_JUDGE_API_KEY=... \
  node plugins/webex/eval/score/run.js <bundle-dir>
```

Take the extracted tasks and captured replies from each `bundle.json`; take the judge's own
ratings from `scorecard.json` and **withhold them from the grader**.

## Delegation package

Self-contained, no repo access needed:

1. **README** — what the judge does, what the grader is being asked for, and the warning not to
   look at judge output first.
2. **The frozen system prompt**, verbatim, including the 1-4 anchors.
3. **The user-prompt template**, so a grader sees exactly what the judge sees.
4. **The examples** — one file, each entry containing the full conversation with `->` markers,
   the extracted title/description, and the reference title. Judge ratings withheld.
5. **A grading sheet** — example id, rating 1-4, one line of reasoning.

### Methodology guardrails

- **Grade blind.** The grader must not see the judge's rating or rationale before recording
  their own. Anchoring would destroy the measurement, and this is the single easiest way to
  invalidate the whole exercise.
- **Rate on the same 1-4 scale, plus one line of reasoning.** Not a free-form score: the graders
  and the judge must be choosing among identical written anchors, or the two are not comparable.
- **Identical inputs.** If the grader sees more or less than the judge, two different tasks are
  being measured.

## Analysis

- Exact agreement and adjacent agreement (within one point), plus the 4x4 of judge rating x
  human rating. Exact match will look poor even for a good judge on a small set, so adjacent
  agreement is the more honest headline.
- Mean difference (judge minus human) to expose systematic leniency or harshness — this is the
  thing a scalar buys that a binary cannot.
- With 24-30 examples a weighted kappa is unstable on a skewed distribution — report the matrix
  and enumerate every disagreement rather than lean on a single coefficient.
- **The disagreements are the actual output.** They show whether the judge is systematically
  lenient, systematically harsh, or just noisy, and each one is worth reading in full. A judge
  that is consistently one band off is correctable by rewording an anchor; one that is noisy is
  not.
- Report separately for real vs constructed examples: constructed cases measure failure-mode
  detection, real cases measure base-rate agreement.

## Known gaps this does not address

- **Response quality is unjudgeable today.** `respond` sends via the model's own message tool,
  which bypasses the eval harness's `sendFn`, so no reply text reaches the bundle. A response
  judge needs that capture problem solved first, and would need its own calibration.
- Calibrating the judge does not validate the *fixtures*. A wrong `expectedAssigned` is a
  different class of error, caught by inspection, not by this.

## Sequence

Done:
1. ~~Live run with the fixed task judge; sane ratings confirmed.~~ (2026-08-28)
2. ~~Self-consistency, 3x identical input: 9/9 stable — 4,4,4 unmodified and 2,2,2 perturbed. It
   also discriminated correctly, rating an injected-detail case 2 rather than 1, i.e. reading the
   anchors rather than collapsing everything bad into the bottom band.~~
4. ~~`eval-s01-release-readiness` brought onto the current fixture schema.~~ (2026-08-29)

Remaining:
3. **Self-consistency for the *response* judge**, 3x identical input. It has never run against
   real data. Not covered by the task judge's result: different prompt, different instrument.
   Do this in-house.
5. **Freeze and version-stamp both prompts.** Nothing below is valid if either changes after.
6. **Generate the material**: three runs each of `eval-s00-smoke` and
   `eval-s01-release-readiness`, scored, keeping every `bundle.json` and `scorecard.json`.
7. **Build the two sets** — ~24 task examples, ~16 response examples, each roughly a third real,
   a third perturbed-wrong, a third perturbed-but-correct.
8. **Package and hand over** (see Delegation package above). Judge ratings withheld.
9. **On return**: exact and adjacent agreement, the 4x4 matrix, mean difference, and a read of
   every disagreement — separately for each judge. If a rubric needs revising, the calibration
   for that judge must be redone against the revised prompt.

## Status

Planned, not started. Blocked on nothing except step 3 and the deploy currently in flight.

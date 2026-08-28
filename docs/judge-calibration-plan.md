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

One narrow question, and only this one:

> Given a conversation and a task extracted from it, is the task's title and description a
> faithful account of that conversation?

Deliberately **not** in scope:
- *Which* observed task corresponds to which expected task — that is deterministic, done by
  `message_ids` overlap in `score-tasks.js`, upstream of the judge.
- Gate tagging, field accuracy, update hits — all deterministic.
- Response quality — a separate judge, not yet wired (see the capture gap in §Known gaps).

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

Target ~24-30 examples, roughly in thirds:

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

For constructed cases the ground truth is known by construction, which is stronger than a human
label. Only the real extractions need blind human grading.

### Where the real examples come from

`eval-s00-smoke` yields only 2 matched pairs per run. `eval/scenarios/eval-s01-release-readiness.json`
has ~10 expected tasks, so it is the better source; several runs of it give both volume and
natural title variation. Note s01's fixture predates the current schema (it still uses
`expectedItems`, `mustExtract`, prose `updates`) and needs the s00 treatment before it can be
run and scored.

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

1. Deploy lands; re-run `eval-s00-smoke`; confirm the fixed judge gives sane ratings.
2. Self-consistency check, 3x identical input.
3. Freeze and version-stamp the judge prompt.
4. Bring `eval-s01-release-readiness` onto the current fixture schema; run it a few times.
5. Build the set: real pairs from those runs, plus constructed perturbations.
6. Package and hand over.
7. On return: agreement table, disagreement review, decide whether the rubric needs revising —
   and if it does, the calibration must be redone against the revised prompt.

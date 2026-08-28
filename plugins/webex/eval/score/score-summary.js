// ********* EVAL/SCORE/SCORE-SUMMARY.JS *********
'use strict';

// Aggregates the individual scorers into one scorecard, as JSON for further
// analysis and as Markdown for the report.
//
// Token figures come from the bundle's own usageSummary, which sums the
// billed buckets rather than the provider's reported `total` — see
// processing/usage/summary.js for why that distinction matters.

const { summarizeUsage } = require('../../processing/usage/summary');

function pct(value) {
  return value === null || value === undefined ? 'n/a' : `${(value * 100).toFixed(1)}%`;
}

function num(value) {
  return typeof value === 'number' ? value.toLocaleString('en-GB') : 'n/a';
}

function buildScorecard({ bundle, gate, tasks, tasksJudge, response }) {
  const meta = bundle?.meta ?? {};
  const usage = bundle?.usageSummary ?? summarizeUsage(bundle?.jobs ?? []);

  return {
    scenarioId: meta.scenarioId ?? null,
    variant: meta.variant ?? null,
    evalRunId: meta.evalRunId ?? null,
    gitSha: meta.gitSha ?? null,
    completedAt: meta.completedAt ?? null,
    totalMs: meta.totalMs ?? null,
    gate: gate?.overall ?? null,
    gateByField: gate?.byField ?? null,
    tasks: tasks?.overall ?? null,
    taskFidelity: tasksJudge?.overall ?? null,
    response: response?.overall ?? null,
    usage: {
      byStep: usage?.byStep ?? {},
      total: usage?.total ?? null,
    },
  };
}

function renderMarkdown({ scorecard, gate, tasks, tasksJudge }) {
  const lines = [];
  const s = scorecard;

  lines.push(`# Eval scorecard — ${s.scenarioId} (${s.variant})`);
  lines.push('');
  lines.push(`- run: \`${s.evalRunId}\``);
  lines.push(`- commit: \`${s.gitSha ?? 'unknown'}\``);
  lines.push(`- completed: ${s.completedAt ?? 'n/a'} (${num(s.totalMs)} ms)`);
  lines.push('');

  lines.push('## Gate tagging');
  lines.push('');
  if (!s.gate || s.gate.messagesScored === 0) {
    lines.push('_No messages carried `expectedTags`._');
  } else {
    lines.push(
      `Fully correct on ${s.gate.fullyCorrect}/${s.gate.messagesScored} messages (${pct(s.gate.accuracy)}).`
    );
    if (s.gate.messagesMissingGateRun) {
      lines.push('');
      lines.push(`**${s.gate.messagesMissingGateRun} message(s) had no gate run at all.**`);
    }
    lines.push('');
    lines.push('| Field | Accuracy | TP | TN | FP | FN |');
    lines.push('|---|---|---|---|---|---|');
    for (const [field, c] of Object.entries(s.gateByField ?? {})) {
      lines.push(
        `| \`${field}\` | ${pct(c.accuracy)} | ${c.truePositive} | ${c.trueNegative} | ${c.falsePositive} | ${c.falseNegative} |`
      );
    }
    const wrong = (gate?.messages ?? []).filter((m) => !m.missing && !m.correct);
    if (wrong.length) {
      lines.push('');
      lines.push('Incorrect messages:');
      for (const m of wrong) {
        const bad = Object.entries(m.fields)
          .filter(([, f]) => !f.correct)
          .map(([k, f]) => `${k}: expected ${f.expected}, got ${f.observed}`)
          .join('; ');
        lines.push(`- msg ${m.number} — ${bad}`);
      }
    }
  }
  lines.push('');

  lines.push('## Task extraction');
  lines.push('');
  if (!s.tasks) {
    lines.push('_No expected tasks in this scenario._');
  } else {
    const t = s.tasks;
    lines.push(
      `Matched ${t.matched}/${t.expected} expected tasks; ${t.missing} missing, ${t.spurious} spurious (${t.observed} extracted in total).`
    );
    lines.push('');
    lines.push('| Field | Correct |');
    lines.push('|---|---|');
    for (const [field, v] of Object.entries(t.byField ?? {})) {
      lines.push(`| \`${field}\` | ${v.correct}/${v.total} |`);
    }
    if (t.updateTotal) {
      lines.push('');
      lines.push(`Update hits: ${t.updateHits}/${t.updateTotal}.`);
      for (const u of tasks?.updates ?? []) {
        if (u.hit) continue;
        lines.push(
          `- \`${u.taskId}\` after msg ${u.afterMessage}: expected \`${u.expectedStatus}\`, got \`${u.observedStatus ?? 'n/a'}\`${u.citesTrigger === false ? ' (did not cite the triggering message)' : ''}`
        );
      }
    }
    if (tasks?.missing?.length) {
      lines.push('');
      lines.push('Missing:');
      for (const m of tasks.missing) lines.push(`- \`${m.expectedId}\` — ${m.title}`);
    }
    if (tasks?.spurious?.length) {
      lines.push('');
      lines.push('Spurious:');
      for (const m of tasks.spurious) lines.push(`- ${m.title} (evidence: ${m.message_ids.join(', ') || 'none'})`);
    }
  }
  lines.push('');

  lines.push('## Task text fidelity (LLM judge)');
  lines.push('');
  if (!s.taskFidelity) {
    lines.push('_Judge not run (`--no-judge`, or judge credentials absent)._');
  } else if (s.taskFidelity.pairs === 0) {
    lines.push('_No matched task pairs to judge._');
  } else {
    const f = s.taskFidelity;
    lines.push(
      `${f.passed}/${f.judged} passed (${pct(f.passRate)}), mean score ${f.meanScore === null ? 'n/a' : f.meanScore.toFixed(2)}.`
    );
    if (f.unjudged) lines.push(`${f.unjudged} pair(s) could not be judged.`);
    lines.push('');
    for (const r of tasksJudge?.results ?? []) {
      const head = r.judged ? `**${r.verdict}** (${r.score})` : `**unjudged** — ${r.error}`;
      lines.push(`- \`${r.expectedId}\` ${head}: ${r.rationale ?? ''}`);
    }
  }
  lines.push('');

  lines.push('## Response quality (LLM judge)');
  lines.push('');
  lines.push(
    s.response
      ? `${s.response.passed}/${s.response.judged} passed (${pct(s.response.passRate)}).`
      : '_Not scored: the respond step sends via the model’s own message tool, which bypasses the eval capture, so no reply text reaches the bundle._'
  );
  lines.push('');

  lines.push('## Token usage');
  lines.push('');
  lines.push('| Step | Calls | Input | Output | Billed total |');
  lines.push('|---|---|---|---|---|');
  for (const [step, b] of Object.entries(s.usage.byStep ?? {})) {
    lines.push(`| ${step} | ${b.calls} | ${num(b.input)} | ${num(b.output)} | ${num(b.total)} |`);
  }
  if (s.usage.total) {
    const t = s.usage.total;
    lines.push(`| **total** | **${t.calls}** | **${num(t.input)}** | **${num(t.output)}** | **${num(t.total)}** |`);
  }
  lines.push('');

  return lines.join('\n');
}

module.exports = { buildScorecard, renderMarkdown };

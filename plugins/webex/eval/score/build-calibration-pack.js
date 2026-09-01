#!/usr/bin/env node
// ********* EVAL/SCORE/BUILD-CALIBRATION-PACK.JS *********
'use strict';

// Assembles the complete grader packs for the judge calibration exercise.
//
//   node plugins/webex/eval/score/build-calibration-pack.js <bundle-dir>...
//
// Writes, into plugins/webex/calibration/ (git-ignored):
//   task-fidelity-marker-{a,b}.md      identical, one per grader
//   response-quality-marker-{a,b}.md   identical, one per grader
//   ANSWER-KEY.md                      NOT for graders
//
// Real examples come from the bundles; the perturbed thirds are read from
// calibration-perturbations.json, hand-authored on purpose — their value is
// that a person chose exactly one thing to break, so the expected band is
// known by construction rather than by human label.
//
// Two deliberate choices, both about not anchoring the grader:
//
// 1. Judge ratings are never emitted. A grader who sees the model's answer
//    first is anchored by it, and the blind labels are the whole exercise.
//
// 2. Real and perturbed examples are interleaved into ONE shuffled block
//    rather than presented as labelled sections. Section headings are
//    themselves an anchor — "Section 2, perturbed to be wrong" tells a grader
//    the answer before they read the example. Interleaving also means every
//    example carries a human label, so human-versus-human agreement is
//    computed over the whole set instead of the real third alone; a ceiling
//    estimated from eight items would have a confidence interval too wide to
//    interpret the judge against, which is the one number the two-marker
//    design exists to produce. The shuffle is seeded, so the order is stable
//    across rebuilds and identical for both markers.
//
// Matching reuses score-tasks.js rather than re-deriving pairs, so a grader
// judges exactly the pairing the scorer will later be measured against.

const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');

const { scoreTasks } = require('./score-tasks');
const { replyForQuestion } = require('./score-response');

const OUT_DIR = path.join(__dirname, '..', '..', 'calibration');

function loadBundle(target) {
  const stat = fs.statSync(target);
  const file = stat.isDirectory() ? path.join(target, 'bundle.json') : target;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// The transcript a grader reads, with the cited lines marked exactly as the
// judge sees them.
function renderConversation(messages, marked) {
  const cited = new Set(marked ?? []);
  return messages
    .map((m) => `${cited.has(m.number) ? '->' : '  '} [${m.number}] ${m.sender}: ${m.text}`)
    .join('\n');
}

function collect(bundleDirs) {
  const conversations = new Map(); // scenarioId -> messages
  const taskExamples = [];
  const responseExamples = [];

  for (const dir of bundleDirs) {
    const bundle = loadBundle(dir);
    const scenario = bundle.scenario ?? {};
    const scenarioId = scenario.id ?? 'unknown';
    const runId = (bundle.meta?.evalRunId ?? 'run').slice(0, 8);
    if (!conversations.has(scenarioId)) conversations.set(scenarioId, scenario.messages ?? []);

    for (const pair of scoreTasks(bundle).matched ?? []) {
      taskExamples.push({
        scenarioId,
        runId,
        cited: (pair.observedMessageIds ?? [])
          .map((id) => Number(String(id).split('-msg-')[1]))
          .filter(Number.isFinite),
        title: pair.observedTitle,
        description: pair.observedDescription,
        reference: pair.expectedTitle,
      });
    }

    for (const check of scenario.recallChecks ?? []) {
      const send = replyForQuestion(bundle.sends, check.questionMessageNumber);
      responseExamples.push({
        scenarioId,
        runId,
        questionNumber: check.questionMessageNumber,
        reply: send ? send.markdown : null,
        points: check.expectedAnswerPoints ?? [],
      });
    }
  }

  return { conversations, taskExamples, responseExamples };
}

const PERTURBATIONS = path.join(__dirname, 'calibration-perturbations.json');

// Fixed-seed shuffle (mulberry32). The order must be stable across rebuilds —
// a grader part-way through a pack that gets regenerated should not find the
// items renumbered — and identical for both markers, or they are not rating
// the same instrument.
function seededShuffle(items, seed) {
  let s = seed >>> 0;
  const rand = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// One flat, shuffled list of {kind, ...} entries per judge. `kind` is what the
// answer key reveals and what the grader never sees.
// Three runs of one scenario produce the same handful of tasks three times
// over, so the real pool is mostly near-duplicates. Grading eight phrasings of
// "rename the export button" measures nothing; the plan's whole argument is
// that composition beats size. Round-robin across reference titles takes the
// widest spread the pool allows before hitting the cap.
const REAL_TASK_EXAMPLES = 8;

function selectRealTasks(taskExamples, cap = REAL_TASK_EXAMPLES) {
  const groups = new Map();
  for (const ex of taskExamples) {
    const key = ex.reference ?? ex.title ?? '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(ex);
  }
  const picked = [];
  const queues = [...groups.values()];
  while (picked.length < cap && queues.some((q) => q.length > 0)) {
    for (const q of queues) {
      if (picked.length >= cap) break;
      if (q.length > 0) picked.push(q.shift());
    }
  }
  return picked;
}

function buildTaskItems({ taskExamples, perturbations }) {
  const p = perturbations.taskFidelity;
  const items = [
    ...selectRealTasks(taskExamples).map((ex) => ({
      kind: 'real',
      cited: ex.cited,
      title: ex.title,
      description: ex.description,
      reference: ex.reference,
      source: `${ex.scenarioId} run ${ex.runId}`,
    })),
    ...p.wrong.map((w) => ({ kind: 'perturbed-wrong', scenarioId: p.conversationId, ...w })),
    ...p.correct.map((c) => ({ kind: 'perturbed-correct', scenarioId: p.conversationId, ...c })),
  ];
  return seededShuffle(items, 0x7a5c);
}

function buildResponseItems({ responseExamples, perturbations, conversations }) {
  const p = perturbations.responseQuality;
  const items = [
    ...responseExamples.map((ex) => ({
      kind: 'real',
      questionNumber: ex.questionNumber,
      reply: ex.reply,
      points: ex.points,
      scenarioId: ex.scenarioId,
      source: `${ex.scenarioId} run ${ex.runId}`,
    })),
    ...[...p.wrong, ...p.correct].map((x) => ({
      kind: x.expected === '4' ? 'perturbed-correct' : 'perturbed-wrong',
      questionNumber: x.questionNumber,
      reply: x.reply,
      // Constructed replies are written against a real question, so they get
      // that question's expected points — the grader must see the identical
      // checklist the judge does.
      points:
        (conversations.expectedPoints ?? {})[
          `${p.conversationId}:${x.questionNumber}`
        ] ?? [],
      scenarioId: p.conversationId,
      perturbation: x.perturbation,
      expected: x.expected,
      why: x.why,
      id: x.id,
    })),
  ];
  return seededShuffle(items, 0x3f19);
}

function quote(text) {
  if (!text) return '  > **(no reply was sent)**';
  return '  > ' + String(text).replace(/\n/g, '\n  > ');
}

function renderTaskPack({ conversations, items, marker }) {
  const lines = [
    `# Calibration pack — Task fidelity (grader ${marker.toUpperCase()})`,
    '',
    'Read `README.md` first. Rate every example below. Work through this whole file',
    'before opening the response-quality pack — switching rubrics example-to-example',
    'reliably produces grader error that looks like judge disagreement.',
    '',
    '**Do not look up the model\'s rating.** It is withheld from your copy on purpose.',
    '',
    '## The rubric',
    '',
    'This is the frozen prompt the automated judge is given, verbatim. Rate against',
    'these anchors, not your own.',
    '',
    '```',
    require('./score-tasks-judge').SYSTEM,
    '```',
    '',
    `Prompt version: \`${require('./score-tasks-judge').PROMPT_VERSION}\``,
    '',
    '## The conversation',
    '',
    'Every example below refers to this conversation. In each example the `->`',
    'markers move: they show the messages *that* extraction cited as its evidence.',
    '',
  ];
  for (const [id, messages] of conversations.byId) {
    lines.push(`### ${id}`, '', '```', renderConversation(messages, []), '```', '');
  }

  lines.push(
    '## Examples',
    '',
    'Each is one extracted task. Some are genuine system output and some were',
    'constructed; you are not told which, and it should not change how you rate them.',
    ''
  );
  items.forEach((ex, i) => {
    // Constructed items name their conversation in the perturbations file;
    // real ones carry their own scenarioId. Falling back to "the only
    // conversation" is correct today, when every example is drawn from one
    // scenario, and silently wrong the moment a second one is added.
    const messages =
      conversations.byId.get(ex.scenarioId ?? ex.conversationId) ??
      conversations.byId.values().next().value ??
      [];
    lines.push(
      `### T-${i + 1}`,
      '',
      '```',
      renderConversation(messages, ex.cited ?? []),
      '```',
      '',
      '- Extracted task:',
      `  - title: ${ex.title ?? '(none)'}`,
      `  - description: ${ex.description ?? '(none)'}`,
      `- Reference title (one acceptable phrasing): ${ex.reference ?? '(none)'}`,
      ''
    );
  });

  lines.push('## Your ratings', '', '| ID | Rating (1-4) | Reason (one line) |', '|---|---|---|');
  items.forEach((_, i) => lines.push(`| T-${i + 1} |  |  |`));
  lines.push('');
  return lines.join('\n');
}

function renderResponsePack({ conversations, items, marker }) {
  const lines = [
    `# Calibration pack — Response quality (grader ${marker.toUpperCase()})`,
    '',
    'Read `README.md` first, and finish the task-fidelity pack before starting this one.',
    '',
    '**Do not look up the model\'s rating.**',
    '',
    '## The rubric',
    '',
    'The frozen prompt the automated judge is given, verbatim.',
    '',
    '```',
    require('./score-response').SYSTEM,
    '```',
    '',
    `Prompt version: \`${require('./score-response').PROMPT_VERSION}\``,
    '',
    '## Examples',
    '',
    'Each shows the conversation up to and including the question (`->`), the reply',
    'that was given, and the facts a correct answer needs to convey. The reply is',
    'sometimes genuine system output and sometimes constructed; you are not told which.',
    '',
    'Judge the reply against the conversation and the listed facts. The facts are a',
    'checklist of substance, not required wording.',
    '',
  ];

  items.forEach((ex, i) => {
    const messages = conversations.byId.get(ex.scenarioId) ?? [];
    const upTo = messages.filter((m) => m.number <= ex.questionNumber);
    lines.push(
      `### Q-${i + 1}`,
      '',
      '```',
      renderConversation(upTo, [ex.questionNumber]),
      '```',
      '',
      '- The reply:',
      '',
      quote(ex.reply),
      '',
      '- Facts a correct answer needs to convey:',
      ...(ex.points ?? []).map((pt) => `  - ${pt}`),
      ''
    );
  });

  lines.push('## Your ratings', '', '| ID | Rating (1-4) | Reason (one line) |', '|---|---|---|');
  items.forEach((_, i) => lines.push(`| Q-${i + 1} |  |  |`));
  lines.push('');
  return lines.join('\n');
}

// Item ids are positions in a shuffle. The seed is fixed, but the item *set*
// depends on which bundles the builder is given, so a rebuild against a
// different set silently renumbers everything — and the answer key regenerates
// in step, so nothing looks wrong. Returned marker sheets would then join
// cleanly onto the wrong items, which is unrecoverable and undetectable after
// the fact. Hashing the exact text each grader saw makes that drift loud:
// re-run the builder, diff the manifest, and any changed row is an id whose
// meaning moved.
function itemFingerprint(ex) {
  const material = [
    ex.kind,
    ex.title ?? '',
    ex.description ?? '',
    ex.reference ?? '',
    ex.reply ?? '',
    (ex.cited ?? []).join(','),
    ex.questionNumber ?? '',
    (ex.points ?? []).join('|'),
  ].join('\u0000');
  return crypto.createHash('sha256').update(material, 'utf8').digest('hex').slice(0, 12);
}

function renderManifest({ taskItems, responseItems, dirs, perturbationsHash }) {
  const lines = [
    '# Pack manifest — distributed version',
    '',
    'Pins the exact packs handed to graders. Before joining returned sheets to judge output,',
    'rebuild and diff this file: any changed row is an item id whose meaning has moved, and',
    'the join would be silently wrong.',
    '',
    `- Perturbations file: \`${perturbationsHash}\``,
    '- Source bundles:',
    ...dirs.map((d) => `  - \`${path.basename(path.resolve(d))}\``),
    '',
    '| ID | Kind | Fingerprint |',
    '|---|---|---|',
  ];
  taskItems.forEach((ex, i) => lines.push(`| T-${i + 1} | ${ex.kind} | \`${itemFingerprint(ex)}\` |`));
  responseItems.forEach((ex, i) => lines.push(`| Q-${i + 1} | ${ex.kind} | \`${itemFingerprint(ex)}\` |`));
  lines.push('');
  return lines.join('\n');
}

function renderAnswerKey({ taskItems, responseItems }) {
  const lines = [
    '# Answer key — DO NOT SEND TO GRADERS',
    '',
    'Which examples in each pack are real system output and which were constructed,',
    'plus the band a working judge should return on each constructed one. Real',
    'examples have no expected band: the human labels are the data there.',
    '',
    '## Task fidelity',
    '',
    '| ID | Kind | Perturbation | Expected | Source / rationale |',
    '|---|---|---|---|---|',
  ];
  taskItems.forEach((ex, i) => {
    lines.push(
      `| T-${i + 1} | ${ex.kind} | ${ex.perturbation ?? '—'} | ${ex.expected ?? '—'} | ${ex.why ?? ex.source ?? ''} |`
    );
  });
  lines.push('', '## Response quality', '', '| ID | Kind | Perturbation | Expected | Source / rationale |', '|---|---|---|---|---|');
  responseItems.forEach((ex, i) => {
    lines.push(
      `| Q-${i + 1} | ${ex.kind} | ${ex.perturbation ?? '—'} | ${ex.expected ?? '—'} | ${ex.why ?? ex.source ?? ''} |`
    );
  });
  lines.push('');
  return lines.join('\n');
}

function main() {
  const dirs = process.argv.slice(2);
  if (dirs.length === 0) {
    console.error('Usage: node eval/score/build-calibration-pack.js <bundle-dir>...');
    process.exit(1);
  }

  const collected = collect(dirs);
  const perturbations = JSON.parse(fs.readFileSync(PERTURBATIONS, 'utf8'));

  // Constructed replies borrow the expected points of the real question they
  // were written against, so grader and judge see the identical checklist.
  const expectedPoints = {};
  for (const ex of collected.responseExamples) {
    expectedPoints[`${ex.scenarioId}:${ex.questionNumber}`] = ex.points;
  }
  const conversations = { byId: collected.conversations, expectedPoints };

  const taskItems = buildTaskItems({ taskExamples: collected.taskExamples, perturbations });
  const responseItems = buildResponseItems({
    responseExamples: collected.responseExamples,
    perturbations,
    conversations,
  });

  fs.mkdirSync(OUT_DIR, { recursive: true });

  // Refuse to clobber sheets a grader has already filled in. The output paths
  // are fixed, so rebuilding after distribution silently destroys the only
  // copy of the human labels the exercise exists to produce; that happened
  // once, and only an already-written agreement.json made the ratings
  // recoverable. --force is available for a deliberate rebuild.
  if (!process.argv.includes('--force')) {
    for (const marker of ['a', 'b']) {
      for (const name of [`task-fidelity-marker-${marker}.md`, `response-quality-marker-${marker}.md`]) {
        const existing = path.join(OUT_DIR, name);
        if (!fs.existsSync(existing)) continue;
        const filled = /^\|\s*[TQ]-\d+\s*\|\s*[1-4]\s*\|/m.test(fs.readFileSync(existing, 'utf8'));
        if (filled) {
          console.error(
            `refusing to overwrite ${name}: it contains grader ratings.\n` +
              'Move the returned sheets aside first, or pass --force if you really mean to discard them.'
          );
          process.exit(1);
        }
      }
    }
  }

  const written = [];
  for (const marker of ['a', 'b']) {
    const t = path.join(OUT_DIR, `task-fidelity-marker-${marker}.md`);
    const r = path.join(OUT_DIR, `response-quality-marker-${marker}.md`);
    fs.writeFileSync(t, renderTaskPack({ conversations, items: taskItems, marker }));
    fs.writeFileSync(r, renderResponsePack({ conversations, items: responseItems, marker }));
    written.push(t, r);
  }
  const key = path.join(OUT_DIR, 'ANSWER-KEY.md');
  fs.writeFileSync(key, renderAnswerKey({ taskItems, responseItems }));

  const manifest = path.join(OUT_DIR, 'MANIFEST.md');
  fs.writeFileSync(
    manifest,
    renderManifest({
      taskItems,
      responseItems,
      dirs,
      perturbationsHash: crypto
        .createHash('sha256')
        .update(fs.readFileSync(PERTURBATIONS))
        .digest('hex')
        .slice(0, 12),
    })
  );

  const count = (items, kind) => items.filter((x) => x.kind === kind).length;
  console.log(`bundles read        : ${dirs.length}`);
  console.log(
    `task examples       : ${taskItems.length} ` +
      `(${count(taskItems, 'real')} real, ${count(taskItems, 'perturbed-wrong')} wrong, ${count(taskItems, 'perturbed-correct')} correct)`
  );
  console.log(
    `response examples   : ${responseItems.length} ` +
      `(${count(responseItems, 'real')} real, ${count(responseItems, 'perturbed-wrong')} wrong, ${count(responseItems, 'perturbed-correct')} correct)`
  );
  for (const f of written) console.log(`  -> ${f}`);
  console.log(`  -> ${key}  (withhold from graders)`);
  console.log(`  -> ${manifest}  (pins this distributed version)`);
}

if (require.main === module) main();

module.exports = {
  collect,
  itemFingerprint,
  renderConversation,
  seededShuffle,
  selectRealTasks,
  buildTaskItems,
  buildResponseItems,
};

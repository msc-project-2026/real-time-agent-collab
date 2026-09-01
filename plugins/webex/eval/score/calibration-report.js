#!/usr/bin/env node
// ********* EVAL/SCORE/CALIBRATION-REPORT.JS *********
'use strict';

// Reads the returned grader sheets and reports agreement.
//
//   node plugins/webex/eval/score/calibration-report.js [--json]
//
// Three sources, joined on the item id (T-n / Q-n):
//   - the marker sheets, one pair per grader, in plugins/webex/calibration/
//   - ANSWER-KEY.md, which says which items were constructed and the band a
//     working judge should return on each
//   - MANIFEST.md, whose fingerprints prove the sheets were graded against the
//     packs as distributed
//
// The join is the dangerous part and is deliberately strict. Item ids are
// positions in a seeded shuffle, so a pack rebuilt against a different set of
// bundles renumbers everything while still looking correct. Every row must
// parse, ids must be unique, both markers must have graded the same id set,
// and every rating must be an integer in 1-4. Anything else aborts rather than
// silently dropping a row and reporting agreement over whatever survived.
//
// The two judges are never pooled. They are separate prompts with separate
// rubrics, and one agreement figure spanning both would describe neither.

const fs = require('node:fs');
const path = require('node:path');

const DIR = path.join(__dirname, '..', '..', 'calibration');
const SCALE = [1, 2, 3, 4];

function readRows(file) {
  const text = fs.readFileSync(file, 'utf8');
  const section = text.slice(text.indexOf('## Your ratings'));
  const rows = new Map();
  for (const line of section.split('\n')) {
    const m = /^\|\s*([TQ]-\d+)\s*\|([^|]*)\|([^|]*)\|/.exec(line);
    if (!m) continue;
    const [, id, ratingCell, reasonCell] = m;
    const raw = ratingCell.trim();
    if (raw === '') throw new Error(`${path.basename(file)}: ${id} has no rating`);
    if (!/^[1-4]$/.test(raw)) {
      throw new Error(`${path.basename(file)}: ${id} rating "${raw}" is not an integer 1-4`);
    }
    if (rows.has(id)) throw new Error(`${path.basename(file)}: duplicate row ${id}`);
    rows.set(id, { rating: Number(raw), reason: reasonCell.trim() });
  }
  if (rows.size === 0) throw new Error(`${path.basename(file)}: no ratings found`);
  return rows;
}

// Expected bands are written as a single value ("4") or a range ("1-2"),
// because a judge landing either side of some perturbations is acceptable.
// Treating "1-2" as a number is the obvious way to score every constructed
// item as a miss, so ranges are parsed into a set.
function parseBand(cell) {
  const raw = cell.trim();
  if (raw === '' || raw === '—' || raw === '-') return null;
  const range = /^([1-4])\s*-\s*([1-4])$/.exec(raw);
  if (range) {
    const [lo, hi] = [Number(range[1]), Number(range[2])].sort((a, b) => a - b);
    return new Set(SCALE.filter((v) => v >= lo && v <= hi));
  }
  if (/^[1-4]$/.test(raw)) return new Set([Number(raw)]);
  throw new Error(`unparseable expected band "${raw}"`);
}

function readAnswerKey() {
  const text = fs.readFileSync(path.join(DIR, 'ANSWER-KEY.md'), 'utf8');
  const key = new Map();
  for (const line of text.split('\n')) {
    const m = /^\|\s*([TQ]-\d+)\s*\|([^|]*)\|([^|]*)\|([^|]*)\|/.exec(line);
    if (!m) continue;
    const [, id, kind, perturbation, expected] = m;
    key.set(id, {
      kind: kind.trim(),
      perturbation: perturbation.trim(),
      expected: parseBand(expected),
    });
  }
  return key;
}

// Judge ratings, if calibration-judge-run.js has been run. Absent until then,
// in which case only the human ceiling is reported.
function readJudgeRatings() {
  const file = path.join(DIR, 'judge-ratings.json');
  if (!fs.existsSync(file)) return null;
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  const byId = new Map();
  for (const r of doc.results ?? []) {
    if (r.rating !== null && r.rating !== undefined) byId.set(r.id, r.rating);
  }
  return { model: doc.model, byId };
}

function readManifest() {
  const file = path.join(DIR, 'MANIFEST.md');
  if (!fs.existsSync(file)) return null;
  const text = fs.readFileSync(file, 'utf8');
  const fp = new Map();
  for (const line of text.split('\n')) {
    const m = /^\|\s*([TQ]-\d+)\s*\|([^|]*)\|\s*`([0-9a-f]{12})`\s*\|/.exec(line);
    if (m) fp.set(m[1], { kind: m[2].trim(), fingerprint: m[3] });
  }
  return fp;
}

// --- agreement -------------------------------------------------------------

function matrix(pairs) {
  const m = SCALE.map(() => SCALE.map(() => 0));
  for (const [a, b] of pairs) m[a - 1][b - 1] += 1;
  return m;
}

// Quadratic weights, because the scale is ordinal: disagreeing 4-vs-1 is a
// worse failure than 4-vs-3, and unweighted kappa treats them alike.
// Expected counts come from the observed marginals, never from a uniform
// assumption.
function quadraticWeightedKappa(pairs) {
  const n = pairs.length;
  if (n === 0) return null;
  const O = matrix(pairs);
  const rowSum = SCALE.map((_, i) => O[i].reduce((a, b) => a + b, 0));
  const colSum = SCALE.map((_, j) => SCALE.reduce((a, _v, i) => a + O[i][j], 0));
  const d = (i, j) => ((i - j) ** 2) / ((SCALE.length - 1) ** 2);

  let num = 0;
  let den = 0;
  for (let i = 0; i < SCALE.length; i += 1) {
    for (let j = 0; j < SCALE.length; j += 1) {
      const E = (rowSum[i] * colSum[j]) / n;
      num += d(i, j) * O[i][j];
      den += d(i, j) * E;
    }
  }
  if (den === 0) return null; // no expected disagreement: kappa undefined
  return 1 - num / den;
}

// Krippendorff's alpha with the ordinal difference function. Reported
// alongside quadratic weighted kappa because the two answer slightly
// different questions: kappa corrects for chance against each rater's own
// marginals, while alpha is a general reliability coefficient defined for any
// number of raters, which is what the LLM-as-a-judge literature has largely
// settled on. With two raters and complete data they track closely; where they
// diverge, it is worth knowing.
//
// Ordinal delta squared between values c and k uses the marginal counts of
// every value between them, so a disagreement spanning a sparsely used band
// counts for less than one spanning a heavily used one.
function krippendorffAlphaOrdinal(pairs) {
  const n = pairs.length;
  if (n === 0) return null;

  // Coincidence matrix: two coders per unit, complete data, so each unit
  // contributes 1 to o[a][b] and 1 to o[b][a].
  const o = SCALE.map(() => SCALE.map(() => 0));
  for (const [a, b] of pairs) {
    o[a - 1][b - 1] += 1;
    o[b - 1][a - 1] += 1;
  }
  const nc = SCALE.map((_, i) => o[i].reduce((x, y) => x + y, 0));
  const total = nc.reduce((x, y) => x + y, 0);
  if (total < 2) return null;

  const delta2 = (ci, ki) => {
    const [lo, hi] = ci <= ki ? [ci, ki] : [ki, ci];
    let sum = 0;
    for (let g = lo; g <= hi; g += 1) sum += nc[g];
    return (sum - (nc[ci] + nc[ki]) / 2) ** 2;
  };

  let Do = 0;
  for (let i = 0; i < SCALE.length; i += 1) {
    for (let j = 0; j < SCALE.length; j += 1) Do += o[i][j] * delta2(i, j);
  }
  Do /= total;

  let De = 0;
  for (let i = 0; i < SCALE.length; i += 1) {
    for (let j = 0; j < SCALE.length; j += 1) De += nc[i] * nc[j] * delta2(i, j);
  }
  De /= total * (total - 1);

  if (De === 0) return null;
  return 1 - Do / De;
}

function agreement(pairs) {
  const n = pairs.length;
  if (n === 0) return null;
  const exact = pairs.filter(([a, b]) => a === b).length;
  const adjacent = pairs.filter(([a, b]) => Math.abs(a - b) <= 1).length;
  const meanDiff = pairs.reduce((s, [a, b]) => s + (a - b), 0) / n;
  const meanAbs = pairs.reduce((s, [a, b]) => s + Math.abs(a - b), 0) / n;
  return {
    n,
    exact,
    exactRate: exact / n,
    adjacent,
    adjacentRate: adjacent / n,
    meanDifference: meanDiff,
    meanAbsoluteDifference: meanAbs,
    qwk: quadraticWeightedKappa(pairs),
    alpha: krippendorffAlphaOrdinal(pairs),
    matrix: matrix(pairs),
  };
}

function distribution(values) {
  const d = { 1: 0, 2: 0, 3: 0, 4: 0 };
  for (const v of values) d[v] += 1;
  return d;
}

function mean(values) {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

// --- report ----------------------------------------------------------------

function analyseJudge({ label, aFile, bFile, key, prefix, judgeRatings }) {
  const A = readRows(path.join(DIR, aFile));
  const B = readRows(path.join(DIR, bFile));

  const ids = [...A.keys()].filter((id) => id.startsWith(prefix));
  const bIds = [...B.keys()].filter((id) => id.startsWith(prefix));
  if (ids.length !== bIds.length || ids.some((id) => !B.has(id))) {
    throw new Error(`${label}: markers graded different item sets`);
  }
  for (const id of ids) {
    if (!key.has(id)) throw new Error(`${label}: ${id} is not in the answer key`);
  }

  const rowOf = (id) => ({ id, a: A.get(id).rating, b: B.get(id).rating, ...key.get(id) });
  const rows = ids
    .sort((x, y) => Number(x.split('-')[1]) - Number(y.split('-')[1]))
    .map((id) => ({ ...rowOf(id), m: judgeRatings?.byId.get(id) ?? null }));

  const subset = (pred) => rows.filter(pred);
  const pairsOf = (rs) => rs.map((r) => [r.a, r.b]);

  const real = subset((r) => r.kind === 'real');
  const constructed = subset((r) => r.kind !== 'real');

  // Did the perturbations land? Only meaningful where a band was constructed.
  const inBand = (marker) =>
    constructed.filter((r) => r.expected && r.expected.has(r[marker])).length;

  // Judge against each human separately, never against an average of them:
  // averaging two ordinal ratings invents a value neither grader gave, and
  // the point of two markers is that they disagree.
  const judged = rows.filter((r) => r.m !== null);
  const vsHuman = judged.length
    ? {
        n: judged.length,
        vsA: agreement(judged.map((r) => [r.m, r.a])),
        vsB: agreement(judged.map((r) => [r.m, r.b])),
        vsAReal: agreement(judged.filter((r) => r.kind === 'real').map((r) => [r.m, r.a])),
        vsBReal: agreement(judged.filter((r) => r.kind === 'real').map((r) => [r.m, r.b])),
        distribution: distribution(judged.map((r) => r.m)),
        mean: mean(judged.map((r) => r.m)),
        inBand: judged.filter((r) => r.expected && r.expected.has(r.m)).length,
        inBandOf: judged.filter((r) => r.expected).length,
        offBand: judged
          .filter((r) => r.expected && !r.expected.has(r.m))
          .map((r) => ({ id: r.id, perturbation: r.perturbation, expected: [...r.expected].join('-'), judge: r.m, a: r.a, b: r.b })),
      }
    : null;

  return {
    label,
    n: rows.length,
    judgeVsHuman: vsHuman,
    counts: {
      real: real.length,
      perturbedWrong: subset((r) => r.kind === 'perturbed-wrong').length,
      perturbedCorrect: subset((r) => r.kind === 'perturbed-correct').length,
    },
    markerA: { distribution: distribution(rows.map((r) => r.a)), mean: mean(rows.map((r) => r.a)) },
    markerB: { distribution: distribution(rows.map((r) => r.b)), mean: mean(rows.map((r) => r.b)) },
    humanVsHuman: {
      all: agreement(pairsOf(rows)),
      realOnly: agreement(pairsOf(real)),
      constructedOnly: agreement(pairsOf(constructed)),
    },
    construction: {
      n: constructed.length,
      markerAInBand: inBand('a'),
      markerBInBand: inBand('b'),
      offBand: constructed
        .filter((r) => r.expected && (!r.expected.has(r.a) || !r.expected.has(r.b)))
        .map((r) => ({
          id: r.id,
          perturbation: r.perturbation,
          expected: [...r.expected].join('-'),
          a: r.a,
          b: r.b,
        })),
    },
    rows,
  };
}

function pct(v) {
  return v === null ? 'n/a' : `${(100 * v).toFixed(1)}%`;
}
function num(v, dp = 2) {
  return v === null || v === undefined ? 'n/a' : v.toFixed(dp);
}

function printAgreement(title, a) {
  if (!a) return console.log(`  ${title}: no items`);
  console.log(
    `  ${title.padEnd(18)} n=${String(a.n).padStart(2)}  exact ${a.exact}/${a.n} (${pct(a.exactRate)})  ` +
      `adjacent ${pct(a.adjacentRate)}  QWK ${num(a.qwk)}  alpha ${num(a.alpha)}  mean diff ${num(a.meanDifference)}`
  );
}

function main() {
  const key = readAnswerKey();
  const manifest = readManifest();
  const judgeRatings = readJudgeRatings();
  if (judgeRatings) console.log(`judge model: ${judgeRatings.model}`);
  if (manifest) {
    console.log(`manifest: ${manifest.size} items pinned (rebuild and diff to confirm no drift)\n`);
  } else {
    console.log('manifest: MISSING — cannot confirm the sheets match the packs as distributed\n');
  }

  const judges = [
    {
      label: 'Task fidelity',
      aFile: 'task-fidelity-marker-a.md',
      bFile: 'task-fidelity-marker-b.md',
      prefix: 'T-',
    },
    {
      label: 'Response quality',
      aFile: 'response-quality-marker-a.md',
      bFile: 'response-quality-marker-b.md',
      prefix: 'Q-',
    },
  ];

  const out = [];
  for (const j of judges) {
    const r = analyseJudge({ ...j, key, judgeRatings });
    out.push(r);

    console.log(`=== ${r.label} ===`);
    console.log(
      `  items: ${r.n}  (${r.counts.real} real, ${r.counts.perturbedWrong} perturbed-wrong, ${r.counts.perturbedCorrect} perturbed-correct)`
    );
    console.log(
      `  marker A: ${JSON.stringify(r.markerA.distribution)} mean ${num(r.markerA.mean)}   ` +
        `marker B: ${JSON.stringify(r.markerB.distribution)} mean ${num(r.markerB.mean)}`
    );
    console.log('  human vs human:');
    printAgreement('all items', r.humanVsHuman.all);
    printAgreement('real only', r.humanVsHuman.realOnly);
    printAgreement('constructed only', r.humanVsHuman.constructedOnly);
    console.log('  4x4 matrix (rows = marker A, cols = marker B), all items:');
    for (const [i, row] of r.humanVsHuman.all.matrix.entries()) {
      console.log(`    ${i + 1} | ${row.map((v) => String(v).padStart(3)).join(' ')}`);
    }
    if (r.judgeVsHuman) {
      const v = r.judgeVsHuman;
      console.log(`  judge: ${JSON.stringify(v.distribution)} mean ${num(v.mean)}  (n=${v.n})`);
      printAgreement('judge vs A', v.vsA);
      printAgreement('judge vs B', v.vsB);
      printAgreement('judge vs A, real', v.vsAReal);
      printAgreement('judge vs B, real', v.vsBReal);
      console.log(`  judge in expected band: ${v.inBand}/${v.inBandOf}`);
      for (const o of v.offBand) {
        console.log(`    judge off-band ${o.id} (${o.perturbation}): expected ${o.expected}, judge=${o.judge} (A=${o.a} B=${o.b})`);
      }
    }
    console.log(
      `  construction: marker A in expected band ${r.construction.markerAInBand}/${r.construction.n}, ` +
        `marker B ${r.construction.markerBInBand}/${r.construction.n}`
    );
    for (const o of r.construction.offBand) {
      console.log(`    off-band ${o.id} (${o.perturbation}): expected ${o.expected}, A=${o.a} B=${o.b}`);
    }
    console.log();
  }

  if (process.argv.includes('--json')) {
    fs.writeFileSync(
      path.join(DIR, 'agreement.json'),
      `${JSON.stringify(out, null, 2)}\n`,
      'utf8'
    );
    console.log(`written: ${path.join(DIR, 'agreement.json')}`);
  }

  if (!judgeRatings) {
    console.log('No judge-ratings.json: run calibration-judge-run.js to add judge-vs-human.');
  }
}

if (require.main === module) main();

module.exports = { quadraticWeightedKappa, krippendorffAlphaOrdinal, agreement, parseBand, readRows, analyseJudge };

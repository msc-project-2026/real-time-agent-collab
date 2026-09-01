#!/usr/bin/env node
// ********* EVAL/SCORE/RERENDER.JS *********
'use strict';

// Rebuilds scorecard.md from an existing scorecard.json.
//
//   node plugins/webex/eval/score/rerender.js <bundle-dir>...
//
// scorecard.json holds every input renderMarkdown needs, so re-rendering costs
// nothing and calls no judge. That matters in two situations that both came up
// in practice: the scorecard markdown drifted behind the scorers (the response
// section reported a pass rate the judge had stopped producing), and scoring
// runs in the deployed container while the renderer is fixed locally. Without
// this, correcting a rendering bug would mean paying for every judge call again.

const fs = require('node:fs');
const path = require('node:path');

const { renderMarkdown } = require('./score-summary');

function main() {
  const dirs = process.argv.slice(2);
  if (dirs.length === 0) {
    console.error('Usage: node eval/score/rerender.js <bundle-dir>...');
    process.exit(1);
  }
  for (const dir of dirs) {
    const file = fs.statSync(dir).isDirectory()
      ? path.join(dir, 'scorecard.json')
      : dir;
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    const out = path.join(path.dirname(file), 'scorecard.md');
    fs.writeFileSync(out, `${renderMarkdown(saved)}\n`, 'utf8');
    console.log(`rendered ${out}`);
  }
}

if (require.main === module) main();

module.exports = { main };

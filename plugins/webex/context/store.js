// ********* CONTEXT/STORE.JS *********
'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const {
  contextDir,
  contextSummaryPath,
  contextAnalysisPath,
} = require('../storage/paths');

const DEFAULT_CONTEXT_SUMMARY = [
  '# Collaboration Context',
  '',
  'No accumulated context has been recorded yet.',
  '',
].join('\n');

async function readContextSummary({ spaceId, explicitRoot }) {
  if (!spaceId) throw new Error('spaceId is required');

  try {
    return await fs.readFile(contextSummaryPath(spaceId, explicitRoot), 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return DEFAULT_CONTEXT_SUMMARY;
    throw err;
  }
}

async function writeContextSummary({ spaceId, summary, explicitRoot }) {
  if (!spaceId) throw new Error('spaceId is required');
  if (typeof summary !== 'string') {
    throw new Error('summary must be a string');
  }

  const trimmed = summary.trim();

  if (!trimmed) {
    throw new Error('summary must not be empty');
  }

  await fs.mkdir(contextDir(spaceId, explicitRoot), {
    recursive: true,
  });

  await fs.writeFile(
    contextSummaryPath(spaceId, explicitRoot),
    `${trimmed}\n`,
    'utf8'
  );

  return {
    ok: true,
    spaceId,
    path: contextSummaryPath(spaceId, explicitRoot),
  };
}

async function writeBatchAnalysis({
  spaceId,
  batchId,
  analysis,
  explicitRoot,
}) {
  if (!spaceId) throw new Error('spaceId is required');
  if (!batchId) throw new Error('batchId is required');
  if (!analysis || typeof analysis !== 'object') {
    throw new Error('analysis object is required');
  }

  const filePath = contextAnalysisPath(spaceId, batchId, explicitRoot);

  await fs.mkdir(path.dirname(filePath), { recursive: true });

  await fs.writeFile(
    filePath,
    `${JSON.stringify(analysis, null, 2)}\n`,
    'utf8'
  );

  return {
    ok: true,
    spaceId,
    batchId,
    path: filePath,
  };
}

module.exports = {
  readContextSummary,
  writeContextSummary,
  writeBatchAnalysis,
};

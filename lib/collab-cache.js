'use strict';

const { readFile, writeFile, listFiles } = require('./github.js');

function getRepoCoords() {
  const owner = process.env.COLLAB_GITHUB_OWNER;
  const repo = process.env.COLLAB_GITHUB_REPO;
  if (!owner || !repo) throw new Error('COLLAB_GITHUB_OWNER and COLLAB_GITHUB_REPO env vars must be set');
  return { owner, repo };
}

async function appendToFile(_roomId, filename, content) {
  const { owner, repo } = getRepoCoords();
  const path = `.collab/${filename}`;
  const existing = (await readFile(owner, repo, path)) ?? '';
  const separator = existing && !existing.endsWith('\n') ? '\n' : '';
  await writeFile(owner, repo, path, existing + separator + content + '\n', `collab: append to ${filename}`);
}

async function readSourceFile(_roomId, filePath) {
  const { owner, repo } = getRepoCoords();
  return readFile(owner, repo, filePath);
}

async function nextSuggestionId(owner, repo) {
  let files;
  try {
    files = await listFiles(owner, repo, '.collab/suggestions');
  } catch {
    files = [];
  }
  const nums = files
    .map((f) => f.match(/^FIX-(\d+)\.json$/))
    .filter(Boolean)
    .map((m) => parseInt(m[1], 10));
  const next = nums.length ? Math.max(...nums) + 1 : 1;
  return `FIX-${String(next).padStart(3, '0')}`;
}

async function saveSuggestion(_roomId, { filePath, proposedContent, explanation }) {
  const { owner, repo } = getRepoCoords();
  const id = await nextSuggestionId(owner, repo);
  const suggestion = {
    id,
    filePath,
    proposedContent,
    explanation,
    status: 'pending',
    createdAt: new Date().toISOString(),
  };
  await writeFile(
    owner,
    repo,
    `.collab/suggestions/${id}.json`,
    JSON.stringify(suggestion, null, 2),
    `collab: add suggestion ${id}`
  );
  return suggestion;
}

async function loadSuggestion(_roomId, id) {
  const { owner, repo } = getRepoCoords();
  const raw = await readFile(owner, repo, `.collab/suggestions/${id}.json`);
  if (!raw) return null;
  return JSON.parse(raw);
}

async function commitSuggestion(_roomId, id) {
  const { owner, repo } = getRepoCoords();
  const path = `.collab/suggestions/${id}.json`;
  const raw = await readFile(owner, repo, path);
  if (!raw) throw new Error(`Suggestion ${id} not found`);
  const suggestion = JSON.parse(raw);
  if (suggestion.status !== 'pending') throw new Error(`Suggestion ${id} is already ${suggestion.status}`);
  await writeFile(
    owner,
    repo,
    suggestion.filePath,
    suggestion.proposedContent,
    `fix: apply ${id}, ${suggestion.explanation}`
  );
  const updated = { ...suggestion, status: 'applied', updatedAt: new Date().toISOString() };
  await writeFile(owner, repo, path, JSON.stringify(updated, null, 2), `collab: mark suggestion ${id} as applied`);
  return { id, filePath: suggestion.filePath };
}

async function updateSuggestionStatus(_roomId, id, status) {
  const { owner, repo } = getRepoCoords();
  const path = `.collab/suggestions/${id}.json`;
  const raw = await readFile(owner, repo, path);
  if (!raw) throw new Error(`Suggestion ${id} not found`);
  const updated = { ...JSON.parse(raw), status, updatedAt: new Date().toISOString() };
  await writeFile(owner, repo, path, JSON.stringify(updated, null, 2), `collab: mark suggestion ${id} as ${status}`);
}

module.exports = {
  appendToFile,
  readSourceFile,
  saveSuggestion,
  loadSuggestion,
  commitSuggestion,
  updateSuggestionStatus,
};

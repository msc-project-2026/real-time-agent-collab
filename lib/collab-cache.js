'use strict';

// Manages reading and writing .collab/ files via the GitHub API, with an
// in-memory cache keyed by Webex room ID to avoid redundant GitHub reads.

const { readFile, writeFile, listFiles } = require('./github.js');

// roomId -> { owner, repo }
const cache = new Map();

function parseRepoUrl(url) {
  const m = url?.match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/);
  return m ? { owner: m[1], repo: m[2] } : null;
}

// Loads project context for a room, bootstrapped from env vars.
// Reads .collab/config.json from GitHub to resolve the primary repo,
// then caches the result so subsequent messages skip the GitHub read.
async function getContext(roomId) {
  if (cache.has(roomId)) return cache.get(roomId);

  const owner = process.env.COLLAB_GITHUB_OWNER;
  const repo = process.env.COLLAB_GITHUB_REPO;
  if (!owner || !repo) {
    throw new Error('COLLAB_GITHUB_OWNER and COLLAB_GITHUB_REPO must be set');
  }

  const raw = await readFile(owner, repo, '.collab/config.json');
  const config = raw ? JSON.parse(raw) : null;
  const primary = config?.repos?.[0]?.url
    ? parseRepoUrl(config.repos[0].url)
    : { owner, repo };

  const ctx = { owner: primary.owner, repo: primary.repo };
  cache.set(roomId, ctx);
  return ctx;
}

// Appends a markdown entry to the given .collab file.
// Always reads fresh from GitHub so concurrent appends don't silently overwrite
// each other (stale cached content + writeFile's fresh SHA fetch = data loss).
async function appendToFile(roomId, filename, entry) {
  const ctx = await getContext(roomId);
  const content = (await readFile(ctx.owner, ctx.repo, `.collab/${filename}`)) ?? '';
  const updated = content.trimEnd() + '\n\n' + entry.trim();
  await writeFile(
    ctx.owner,
    ctx.repo,
    `.collab/${filename}`,
    updated,
    `collab: update ${filename}`
  );
}

// Reads a source file from the project repo (used by browser fix suggestions).
async function readSourceFile(roomId, filePath) {
  const ctx = await getContext(roomId);
  return readFile(ctx.owner, ctx.repo, filePath);
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

async function nextIssueId(owner, repo) {
  const raw = await readFile(owner, repo, '.collab/issues.md');
  if (!raw) return 'I-001';
  const nums = [...raw.matchAll(/^## I-(\d+)/gm)].map((m) => parseInt(m[1], 10));
  const next = nums.length ? Math.max(...nums) + 1 : 1;
  return `I-${String(next).padStart(3, '0')}`;
}

async function saveIssue(roomId, { title, severity, description }) {
  const ctx = await getContext(roomId);
  const id = await nextIssueId(ctx.owner, ctx.repo);
  const entry = [
    `## ${id}`,
    `- **Title:** ${title}`,
    `- **Source:** browser`,
    `- **Severity:** ${severity}`,
    `- **Status:** open`,
    `- **Reported at:** ${new Date().toISOString()}`,
    `- **Description:** ${description}`,
  ].join('\n');
  await appendToFile(roomId, 'issues.md', entry);
  return { id };
}

async function saveSuggestion(roomId, { filePath, proposedContent, explanation }) {
  const ctx = await getContext(roomId);
  const id = await nextSuggestionId(ctx.owner, ctx.repo);
  const suggestion = {
    id,
    filePath,
    proposedContent,
    explanation,
    status: 'pending',
    createdAt: new Date().toISOString(),
  };
  await writeFile(
    ctx.owner,
    ctx.repo,
    `.collab/suggestions/${id}.json`,
    JSON.stringify(suggestion, null, 2),
    `collab: add suggestion ${id}`
  );
  return suggestion;
}

async function loadSuggestion(roomId, id) {
  const ctx = await getContext(roomId);
  const raw = await readFile(ctx.owner, ctx.repo, `.collab/suggestions/${id}.json`);
  if (!raw) return null;
  return JSON.parse(raw);
}

async function commitSuggestion(roomId, id) {
  const ctx = await getContext(roomId);
  const path = `.collab/suggestions/${id}.json`;
  const raw = await readFile(ctx.owner, ctx.repo, path);
  if (!raw) throw new Error(`Suggestion ${id} not found`);
  const suggestion = JSON.parse(raw);
  if (suggestion.status !== 'pending') throw new Error(`Suggestion ${id} is already ${suggestion.status}`);
  await writeFile(
    ctx.owner,
    ctx.repo,
    suggestion.filePath,
    suggestion.proposedContent,
    `fix: apply ${id}, ${suggestion.explanation}`
  );
  const updated = { ...suggestion, status: 'applied', updatedAt: new Date().toISOString() };
  await writeFile(ctx.owner, ctx.repo, path, JSON.stringify(updated, null, 2), `collab: mark suggestion ${id} as applied`);
  return { id, filePath: suggestion.filePath };
}

async function updateSuggestionStatus(roomId, id, status) {
  const ctx = await getContext(roomId);
  const path = `.collab/suggestions/${id}.json`;
  const raw = await readFile(ctx.owner, ctx.repo, path);
  if (!raw) throw new Error(`Suggestion ${id} not found`);
  const updated = { ...JSON.parse(raw), status, updatedAt: new Date().toISOString() };
  await writeFile(ctx.owner, ctx.repo, path, JSON.stringify(updated, null, 2), `collab: mark suggestion ${id} as ${status}`);
}

module.exports = {
  getContext,
  appendToFile,
  saveIssue,
  readSourceFile,
  saveSuggestion,
  loadSuggestion,
  commitSuggestion,
  updateSuggestionStatus,
};

'use strict';

// Manages reading and writing .collab/ files via the GitHub API, with an
// in-memory cache keyed by Webex room ID to avoid redundant GitHub reads.

const { readFile, writeFile } = require('./github.js');

// roomId -> { owner, repo, files: Map<filename, content> }
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

  // Set these in Railway environment variables (or .env for local dev):
  // COLLAB_GITHUB_OWNER=msc-project-2026
  // COLLAB_GITHUB_REPO=real-time-agent-collab
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

  const ctx = { owner: primary.owner, repo: primary.repo, files: new Map() };
  cache.set(roomId, ctx);
  return ctx;
}

// Appends a markdown entry to the given .collab file, reading from GitHub
// on first access per room and flushing writes back immediately.
async function appendToFile(roomId, filename, entry) {
  const ctx = await getContext(roomId);

  let content = ctx.files.get(filename);
  if (content === undefined) {
    content = (await readFile(ctx.owner, ctx.repo, `.collab/${filename}`)) ?? '';
    ctx.files.set(filename, content);
  }

  const updated = content.trimEnd() + '\n\n' + entry.trim();
  ctx.files.set(filename, updated);
  await writeFile(
    ctx.owner,
    ctx.repo,
    `.collab/${filename}`,
    updated,
    `collab: update ${filename}`
  );
}

module.exports = { getContext, appendToFile };

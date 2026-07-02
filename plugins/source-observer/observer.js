'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const {
  readFile,
  writeFile,
  getCommitsSince,
  getCommitDiff,
} = require('@collab/github');

const INTERVAL_MS = 30 * 60 * 1000;
const BOOTSTRAP_REPO = 'msc-project-2026/web-app-test';
const STATE_FILE = '/home/node/.openclaw/workspace/source-observer-state.json';
const CONTEXT_PATH = '.collab/context.md';
const QUESTIONS_PATH = '.collab/open-questions.md';
const CONFIG_PATH = '.collab/config.json';
const MAX_DIFF_CHARS = 12000;
const MAX_SEEN_SHAS = 200;

// Keywords that mark a commit as significant enough to notify the Webex space.
const SIGNIFICANT_KEYWORDS =
  /\b(breaking|deploy|revert|hotfix|rollback|critical|urgent)\b/i;
// Conventional commit breaking-change marker (feat!: / fix!: etc.)
const CONVENTIONAL_BREAKING = /^(fix|feat|refactor|perf|revert)!:/i;
const LARGE_COMMIT_FILE_COUNT = 6;

function isSignificant(commitMessage, files) {
  if (SIGNIFICANT_KEYWORDS.test(commitMessage)) return true;
  if (CONVENTIONAL_BREAKING.test(commitMessage)) return true;
  if (files.length >= LARGE_COMMIT_FILE_COUNT) return true;
  return false;
}

function createObserver({
  log = console,
  dispatchAgentPrompt,
  github = { readFile, writeFile, getCommitsSince, getCommitDiff },
  stateFile = STATE_FILE,
  now = () => new Date(),
  notifyRoom = null, // async (spaceId, text) => void — optional, injected by channel.js
} = {}) {
  if (!dispatchAgentPrompt) {
    throw new Error('dispatchAgentPrompt is required');
  }

  return {
    intervalMs: INTERVAL_MS,
    tick: () =>
      runTick({
        log,
        dispatchAgentPrompt,
        github,
        stateFile,
        now,
        notifyRoom,
      }),
  };
}

async function runTick({ log, dispatchAgentPrompt, github, stateFile, now, notifyRoom }) {
  const checkedAt = now();
  const bootstrap = parseRepoUrl(BOOTSTRAP_REPO);
  const state = await readState(stateFile);
  const config = await readConfig(github, bootstrap);
  const repoConfigs = Array.isArray(config.repos) ? config.repos : [];
  const spaceId = config.spaceId ?? null;

  let foundCount = 0;
  let ignoredCollabCount = 0;
  const processed = [];
  const stateUpdates = new Map();

  for (const repoConfig of repoConfigs) {
    const repo = parseRepoUrl(repoConfig.url);
    const repoKey = `${repo.owner}/${repo.repo}`;
    const repoState = state.repos?.[repoKey] ?? {};
    const since = repoState.lastCheckedAt ?? new Date(checkedAt.getTime() - INTERVAL_MS).toISOString();
    const seenShas = new Set(repoState.seenShas ?? []);

    const commits = await github.getCommitsSince(repo.owner, repo.repo, since);
    const ordered = [...commits].reverse();
    const nextSeen = new Set(seenShas);

    for (const commit of ordered) {
      const sha = commit.sha;
      if (!sha || seenShas.has(sha)) continue;
      foundCount += 1;

      const diff = await github.getCommitDiff(repo.owner, repo.repo, sha);
      const files = parseChangedFiles(diff);
      nextSeen.add(sha);

      if (files.length > 0 && files.every(isCollabPath)) {
        ignoredCollabCount += 1;
        continue;
      }

      const sourceFiles = files.filter((file) => !isCollabPath(file));
      const sourceDiff = trimDiff(removeCollabDiffBlocks(diff));
      if (!sourceDiff.trim() && sourceFiles.length === 0) {
        ignoredCollabCount += 1;
        continue;
      }

      const shortSha = sha.slice(0, 7);
      const commitMessage = commit.commit?.message ?? '';
      const summary = normalizeAgentSummary(
        await dispatchAgentPrompt(
          buildSummaryPrompt({
            repoName: repoConfig.name || repo.repo,
            repoKey,
            sha: shortSha,
            commitMessage,
            files: sourceFiles,
            diff: sourceDiff,
          })
        )
      );

      processed.push({
        repoName: repoConfig.name || repo.repo,
        repo: repoKey,
        sha,
        shortSha,
        commitMessage,
        files: sourceFiles,
        summary,
      });

      // Notify the Webex space immediately for significant commits so the team
      // doesn't have to wait for the next context.md write to notice big changes.
      if (notifyRoom && spaceId && isSignificant(commitMessage, sourceFiles)) {
        notifyRoom(
          spaceId,
          `📌 Notable commit in **${repoConfig.name || repo.repo}**: ${summary} (\`${shortSha}\`)`
        ).catch((err) =>
          log?.warn?.(`[source-observer] Webex notify failed: ${err?.message ?? err}`)
        );
      }
    }

    stateUpdates.set(repoKey, {
      lastCheckedAt: checkedAt.toISOString(),
      seenShas: [...nextSeen].slice(-MAX_SEEN_SHAS),
    });
  }

  if (processed.length > 0) {
    const existingContext =
      (await github.readFile(bootstrap.owner, bootstrap.repo, CONTEXT_PATH)) ??
      '# Context\n';
    const nextContext =
      existingContext.trimEnd() +
      '\n\n' +
      formatContextEntries(processed, checkedAt.toISOString()) +
      '\n';

    await github.writeFile(
      bootstrap.owner,
      bootstrap.repo,
      CONTEXT_PATH,
      nextContext,
      'chore: update source observer context'
    );

    const existingQuestions = await github.readFile(
      bootstrap.owner,
      bootstrap.repo,
      QUESTIONS_PATH
    );
    let resolvedCount = 0;
    if (existingQuestions !== null) {
      const resolved = resolveOpenQuestions(existingQuestions, processed);
      resolvedCount = resolved.resolvedCount;
      if (resolved.changed) {
        await github.writeFile(
          bootstrap.owner,
          bootstrap.repo,
          QUESTIONS_PATH,
          resolved.content,
          'chore: resolve source observer questions'
        );
      }
    }

    log?.info?.(
      `[source-observer] repos checked=${repoConfigs.length}, commits found=${foundCount}, ` +
        `.collab ignored=${ignoredCollabCount}, context entries written=${processed.length}, ` +
        `questions resolved=${resolvedCount}`
    );
  }

  for (const [repoKey, repoState] of stateUpdates) {
    state.repos ??= {};
    state.repos[repoKey] = repoState;
  }
  await writeState(stateFile, state);
}

async function readConfig(github, repo) {
  const raw = await github.readFile(repo.owner, repo.repo, CONFIG_PATH);
  if (!raw) {
    throw new Error(`${CONFIG_PATH} not found in ${repo.owner}/${repo.repo}`);
  }
  return JSON.parse(raw);
}

function parseRepoUrl(raw) {
  const text = String(raw ?? '').trim();
  const withoutProtocol = text
    .replace(/^https:\/\/github\.com\//, '')
    .replace(/^git@github\.com:/, '')
    .replace(/\.git$/, '');
  const [owner, repo] = withoutProtocol.split('/');
  if (!owner || !repo) {
    throw new Error(`Invalid GitHub repo reference: ${raw}`);
  }
  return { owner, repo };
}

async function readState(stateFile) {
  try {
    const raw = await fs.readFile(stateFile, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : { repos: {} };
  } catch (err) {
    if (err?.code === 'ENOENT') return { repos: {} };
    throw err;
  }
}

async function writeState(stateFile, state) {
  await fs.mkdir(path.dirname(stateFile), { recursive: true });
  await fs.writeFile(stateFile, JSON.stringify(state, null, 2) + '\n');
}

function parseChangedFiles(diff) {
  const files = [];
  for (const line of String(diff).split('\n')) {
    if (!line.startsWith('diff --git ')) continue;
    const match = line.match(/^diff --git a\/(.+) b\/(.+)$/);
    if (!match) continue;
    const file = unquoteDiffPath(match[2] === '/dev/null' ? match[1] : match[2]);
    if (file && !files.includes(file)) files.push(file);
  }
  return files;
}

function unquoteDiffPath(filePath) {
  return String(filePath ?? '')
    .replace(/^"|"$/g, '')
    .replace(/^a\//, '')
    .replace(/^b\//, '');
}

function isCollabPath(filePath) {
  return unquoteDiffPath(filePath).startsWith('.collab/');
}

function removeCollabDiffBlocks(diff) {
  const blocks = String(diff).split(/(?=^diff --git )/m);
  return blocks
    .filter((block) => {
      const files = parseChangedFiles(block);
      return files.length === 0 || !files.every(isCollabPath);
    })
    .join('');
}

function trimDiff(diff) {
  const text = String(diff ?? '').trim();
  if (text.length <= MAX_DIFF_CHARS) return text;
  return `${text.slice(0, MAX_DIFF_CHARS)}\n\n[diff truncated]`;
}

function buildSummaryPrompt({ repoName, repoKey, sha, commitMessage, files, diff }) {
  return [
    'You are the OpenClaw source observer for an engineering collaboration workspace.',
    'Summarize this source-code commit for future project context.',
    '',
    'Rules:',
    '- Output exactly one concise sentence.',
    '- Do not use markdown.',
    '- Do not use a bullet.',
    '- Do not list files.',
    '- Focus on the engineering meaning of the change, not raw diff mechanics.',
    '',
    `Repo name: ${repoName}`,
    `Repo: ${repoKey}`,
    `Commit: ${sha}`,
    `Commit message: ${firstLine(commitMessage)}`,
    `Changed files: ${files.join(', ') || '(none)'}`,
    '',
    'Diff:',
    diff || '(no source diff available)',
  ].join('\n');
}

function normalizeAgentSummary(raw) {
  const line = String(raw ?? '')
    .split('\n')
    .map((part) => part.trim())
    .find(Boolean);
  if (!line) return 'The commit updated the source code.';
  return line
    .replace(/^[-*]\s+/, '')
    .replace(/^["']|["']$/g, '')
    .trim();
}

function formatContextEntries(entries, timestamp) {
  const lines = [`## Source Update - ${timestamp}`, ''];
  for (const entry of entries) {
    lines.push(`- \`${entry.shortSha}\` ${entry.repoName}: ${entry.summary}`);
    lines.push(`  Files: ${formatFiles(entry.files)}`);
  }
  return lines.join('\n');
}

function formatFiles(files) {
  if (!files?.length) return '`(none)`';
  return files.map((file) => `\`${file}\``).join(', ');
}

function resolveOpenQuestions(content, commits) {
  let resolvedCount = 0;
  const lines = String(content).split('\n');
  const nextLines = lines.map((line) => {
    const checkbox = line.match(/^(\s*-\s*)\[\s\]\s+(.+?)\s*$/);
    if (checkbox) {
      const match = findReferencingCommit(checkbox[2], commits);
      if (!match) return line;
      resolvedCount += 1;
      return `${checkbox[1]}[x] ${checkbox[2]} - Resolved by ${match.shortSha}`;
    }

    const plain = line.match(/^(\s*-\s+)(?!\[[xX ]\]\s)(.+?)\s*$/);
    if (!plain || /resolved by/i.test(plain[2])) return line;

    const match = findReferencingCommit(plain[2], commits);
    if (!match) return line;
    resolvedCount += 1;
    return `${plain[1]}${plain[2]} - Resolved by ${match.shortSha}`;
  });

  const nextContent = nextLines.join('\n');
  return {
    content: nextContent,
    changed: nextContent !== content,
    resolvedCount,
  };
}

function findReferencingCommit(question, commits) {
  const normalizedQuestion = normalizeForMatch(question);
  if (!normalizedQuestion) return null;

  return commits.find((commit) => {
    const message = normalizeForMatch(commit.commitMessage);
    return (
      message.includes(normalizedQuestion) ||
      message.includes(`[${normalizedQuestion}]`)
    );
  });
}

function normalizeForMatch(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function firstLine(value) {
  return String(value ?? '').split('\n')[0].trim();
}

module.exports = {
  createObserver,
  runTick,
  parseRepoUrl,
  parseChangedFiles,
  isCollabPath,
  isSignificant,
  removeCollabDiffBlocks,
  buildSummaryPrompt,
  normalizeAgentSummary,
  formatContextEntries,
  resolveOpenQuestions,
};

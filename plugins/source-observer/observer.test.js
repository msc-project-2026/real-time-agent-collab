'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  runTick,
  parseChangedFiles,
  isCollabPath,
  removeCollabDiffBlocks,
  normalizeAgentSummary,
  formatContextEntries,
  resolveOpenQuestions,
} = require('./observer');

const SOURCE_DIFF = [
  'diff --git a/src/App.jsx b/src/App.jsx',
  'index 1111111..2222222 100644',
  '--- a/src/App.jsx',
  '+++ b/src/App.jsx',
  '@@ -1 +1 @@',
  '-old',
  '+new',
  '',
].join('\n');

const COLLAB_DIFF = [
  'diff --git a/.collab/context.md b/.collab/context.md',
  'index 1111111..2222222 100644',
  '--- a/.collab/context.md',
  '+++ b/.collab/context.md',
  '@@ -1 +1 @@',
  '-old',
  '+new',
  '',
].join('\n');

test('parses changed files and detects .collab paths', () => {
  assert.deepEqual(parseChangedFiles(SOURCE_DIFF + COLLAB_DIFF), [
    'src/App.jsx',
    '.collab/context.md',
  ]);
  assert.equal(isCollabPath('.collab/context.md'), true);
  assert.equal(isCollabPath('src/App.jsx'), false);
});

test('removes .collab diff blocks', () => {
  const filtered = removeCollabDiffBlocks(SOURCE_DIFF + COLLAB_DIFF);
  assert.match(filtered, /src\/App\.jsx/);
  assert.doesNotMatch(filtered, /\.collab\/context\.md/);
});

test('normalizes agent replies to the first clean line', () => {
  assert.equal(
    normalizeAgentSummary('\n- Adds login state handling.\nExtra detail'),
    'Adds login state handling.'
  );
});

test('formats context entries', () => {
  const formatted = formatContextEntries(
    [
      {
        shortSha: 'abc1234',
        repoName: 'frontend',
        summary: 'Adds login state handling.',
        files: ['src/App.jsx'],
      },
    ],
    '2026-06-22T12:00:00.000Z'
  );

  assert.match(formatted, /## Source Update - 2026-06-22T12:00:00\.000Z/);
  assert.match(formatted, /`abc1234` frontend: Adds login state handling\./);
  assert.match(formatted, /Files: `src\/App\.jsx`/);
});

test('resolves checkbox and plain open questions from commit messages', () => {
  const result = resolveOpenQuestions(
    [
      '# Open Questions',
      '',
      '- [ ] Should login persist across refresh?',
      '- Which route owns onboarding?',
      '- [x] Already done',
      '',
    ].join('\n'),
    [
      {
        shortSha: 'abc1234',
        commitMessage: 'Implement Should login persist across refresh?',
      },
      {
        shortSha: 'def5678',
        commitMessage: 'Fix Which route owns onboarding?',
      },
    ]
  );

  assert.equal(result.resolvedCount, 2);
  assert.match(
    result.content,
    /- \[x\] Should login persist across refresh\? - Resolved by abc1234/
  );
  assert.match(
    result.content,
    /- Which route owns onboarding\? - Resolved by def5678/
  );
});

test('ignores .collab-only commits without writing context', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'source-observer-'));
  const stateFile = path.join(dir, 'state.json');
  const writes = [];

  await runTick({
    log: { info: () => assert.fail('no info log expected') },
    dispatchAgentPrompt: async () => assert.fail('agent should not be called'),
    stateFile,
    now: () => new Date('2026-06-22T12:00:00.000Z'),
    github: {
      readFile: async (_owner, _repo, filePath) => {
        if (filePath === '.collab/config.json') {
          return JSON.stringify({
            repos: [{ url: 'msc-project-2026/web-app-test', name: 'frontend' }],
          });
        }
        return null;
      },
      writeFile: async (...args) => writes.push(args),
      getCommitsSince: async () => [
        {
          sha: 'abc123456789',
          commit: { message: 'chore: update context' },
        },
      ],
      getCommitDiff: async () => COLLAB_DIFF,
    },
  });

  assert.deepEqual(writes, []);
  const state = JSON.parse(await fs.readFile(stateFile, 'utf8'));
  assert.equal(
    state.repos['msc-project-2026/web-app-test'].lastCheckedAt,
    '2026-06-22T12:00:00.000Z'
  );
});

test('does not advance state when context write fails', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'source-observer-'));
  const stateFile = path.join(dir, 'state.json');

  await assert.rejects(
    runTick({
      log: { info: () => {} },
      dispatchAgentPrompt: async () => 'Adds login state handling.',
      stateFile,
      now: () => new Date('2026-06-22T12:00:00.000Z'),
      github: {
        readFile: async (_owner, _repo, filePath) => {
          if (filePath === '.collab/config.json') {
            return JSON.stringify({
              repos: [
                { url: 'msc-project-2026/web-app-test', name: 'frontend' },
              ],
            });
          }
          if (filePath === '.collab/context.md') return '# Context\n';
          if (filePath === '.collab/open-questions.md') return '# Open Questions\n';
          return null;
        },
        writeFile: async () => {
          throw new Error('write failed');
        },
        getCommitsSince: async () => [
          {
            sha: 'abc123456789',
            commit: { message: 'feat: add login state' },
          },
        ],
        getCommitDiff: async () => SOURCE_DIFF,
      },
    }),
    /write failed/
  );

  await assert.rejects(fs.readFile(stateFile, 'utf8'), /ENOENT/);
});

test('writes context with an agent summary for source commits', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'source-observer-'));
  const stateFile = path.join(dir, 'state.json');
  const writes = [];
  const logs = [];

  await runTick({
    log: { info: (line) => logs.push(line) },
    dispatchAgentPrompt: async (prompt) => {
      assert.match(prompt, /Repo name: frontend/);
      assert.match(prompt, /Changed files: src\/App\.jsx/);
      assert.doesNotMatch(prompt, /\.collab\/context\.md/);
      return '- Adds login state handling.';
    },
    stateFile,
    now: () => new Date('2026-06-22T12:00:00.000Z'),
    github: {
      readFile: async (_owner, _repo, filePath) => {
        if (filePath === '.collab/config.json') {
          return JSON.stringify({
            repos: [{ url: 'msc-project-2026/web-app-test', name: 'frontend' }],
          });
        }
        if (filePath === '.collab/context.md') return '# Context\n';
        if (filePath === '.collab/open-questions.md') {
          return '- [ ] Should login persist across refresh?\n';
        }
        return null;
      },
      writeFile: async (_owner, _repo, filePath, content) => {
        writes.push({ filePath, content });
      },
      getCommitsSince: async () => [
        {
          sha: 'abc123456789',
          commit: {
            message: 'feat: Should login persist across refresh?',
          },
        },
      ],
      getCommitDiff: async () => SOURCE_DIFF + COLLAB_DIFF,
    },
  });

  const contextWrite = writes.find((write) => write.filePath === '.collab/context.md');
  const questionWrite = writes.find(
    (write) => write.filePath === '.collab/open-questions.md'
  );

  assert.match(contextWrite.content, /frontend: Adds login state handling\./);
  assert.match(contextWrite.content, /Files: `src\/App\.jsx`/);
  assert.match(
    questionWrite.content,
    /- \[x\] Should login persist across refresh\? - Resolved by abc1234/
  );
  assert.match(logs[0], /context entries written=1/);
});

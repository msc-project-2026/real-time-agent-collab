'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { loadWithMocks, makeLog } = require('./helpers.cjs');

// ---------------------------------------------------------------------------
// Category: runSummarizeStep — the v3 §9 / phase 7 recall-summary step. Same
// isolated, fresh-context spawn shape as dispatchTaggingGate and extract, but
// summarization-only: disableMessageTool is always set (like extract), and
// it gets a same-thread recency block (recentSummaries) that extract/respond
// don't have.
// ---------------------------------------------------------------------------

describe('runSummarizeStep', () => {
  function loadSummarize(t, overrides = {}) {
    const collaborators = {
      getThread: t.mock.fn(async () => ({
        pending: [],
        processing: [
          { id: 'msg-1', senderName: 'Ada', content: 'We picked Postgres for storage.', botIsMentioned: false, datetime: null },
        ],
        processed: [],
      })),
      readRecallEntries: t.mock.fn(async () => []),
      getCollabAgentId: t.mock.fn(() => 'main'),
      ...overrides,
    };

    const loaded = loadWithMocks(require.resolve('../processing/summarize/dispatch'), {
      [require.resolve('../storage/threads-store')]: {
        getThread: collaborators.getThread,
      },
      [require.resolve('../storage/recall-store')]: {
        readRecallEntries: collaborators.readRecallEntries,
      },
      [require.resolve('../runtime')]: {
        getCollabAgentId: collaborators.getCollabAgentId,
      },
    });
    t.after(loaded.restore);

    return { ...loaded.subject, collaborators };
  }

  function makeAgentRuntime(t, { runEmbeddedAgent } = {}) {
    return {
      config: { current: t.mock.fn(() => ({ agents: { defaults: {} } })) },
      agent: {
        resolveAgentWorkspaceDir: t.mock.fn(() => '/workspace/main'),
        resolveAgentDir: t.mock.fn(() => '/workspace/main/.agent'),
        runEmbeddedAgent: runEmbeddedAgent ?? t.mock.fn(async () => ({ payloads: [] })),
      },
    };
  }

  test('runs an embedded agent turn with the message tool disabled and returns outcome metadata', async (t) => {
    const runCalls = [];
    const runEmbeddedAgent = t.mock.fn(async (params) => {
      runCalls.push(params);
      return {
        payloads: [{ text: 'done' }],
        meta: { toolSummary: { calls: 1 } },
      };
    });
    const pluginRuntime = makeAgentRuntime(t, { runEmbeddedAgent });
    const { runSummarizeStep } = loadSummarize(t);

    const result = await runSummarizeStep({
      pluginRuntime,
      spaceId: 'space-1',
      threadKey: '__main__',
      messageIds: ['msg-1'],
      log: makeLog(t),
    });

    assert.equal(runEmbeddedAgent.mock.callCount(), 1);
    const params = runCalls[0];
    assert.equal(params.sessionKey, 'agent:main:webex:space-1:summarize:__main__');
    assert.equal(params.agentId, 'main');
    assert.equal(params.workspaceDir, '/workspace/main');
    assert.equal(params.agentDir, '/workspace/main/.agent');
    // Unlike respond, summarization never sends — this must always be set.
    assert.equal(params.disableMessageTool, true);
    assert.match(params.prompt, /write_summary/);
    assert.match(params.prompt, /We picked Postgres for storage\./);

    assert.equal(result.outcome, 'success');
    assert.equal(result.toolCalls, 1);
    assert.equal(result.sessionKey, params.sessionKey);
    assert.equal(result.runId, params.runId);
  });

  test('includes only same-thread recent summaries, most recent first, as continuity context', async (t) => {
    const runCalls = [];
    const runEmbeddedAgent = t.mock.fn(async (params) => {
      runCalls.push(params);
      return { payloads: [] };
    });
    const pluginRuntime = makeAgentRuntime(t, { runEmbeddedAgent });
    const { runSummarizeStep } = loadSummarize(t, {
      readRecallEntries: t.mock.fn(async () => [
        { id: 'recall_older', thread_id: '__main__', summary_text: 'Older summary.', created_at: '2026-01-01T00:00:00.000Z' },
        { id: 'recall_newer', thread_id: '__main__', summary_text: 'Newer summary.', created_at: '2026-01-02T00:00:00.000Z' },
        { id: 'recall_other_thread', thread_id: 'thread-b', summary_text: 'Other thread summary.', created_at: '2026-01-03T00:00:00.000Z' },
      ]),
    });

    await runSummarizeStep({
      pluginRuntime,
      spaceId: 'space-1',
      threadKey: '__main__',
      messageIds: ['msg-1'],
      log: makeLog(t),
    });

    const prompt = runCalls[0].prompt;
    assert.match(prompt, /Newer summary\./);
    assert.match(prompt, /Older summary\./);
    assert.doesNotMatch(prompt, /Other thread summary\./);
    // Most recent first.
    assert.ok(prompt.indexOf('Newer summary.') < prompt.indexOf('Older summary.'));
  });

  test('includes spaceId and threadId as copyable facts in the prompt', async (t) => {
    const runCalls = [];
    const runEmbeddedAgent = t.mock.fn(async (params) => {
      runCalls.push(params);
      return { payloads: [] };
    });
    const pluginRuntime = makeAgentRuntime(t, { runEmbeddedAgent });
    const { runSummarizeStep } = loadSummarize(t);

    await runSummarizeStep({
      pluginRuntime,
      spaceId: 'space-1',
      threadKey: 'thread-root-message-1',
      messageIds: ['msg-1'],
      log: makeLog(t),
    });

    assert.match(runCalls[0].prompt, /spaceId: `space-1`/);
    assert.match(runCalls[0].prompt, /threadId: `thread-root-message-1`/);
  });

  test('propagates a spawn failure instead of swallowing it', async (t) => {
    const pluginRuntime = makeAgentRuntime(t, {
      runEmbeddedAgent: async () => {
        throw new Error('provider timeout');
      },
    });
    const { runSummarizeStep } = loadSummarize(t);

    await assert.rejects(
      runSummarizeStep({
        pluginRuntime,
        spaceId: 'space-1',
        threadKey: '__main__',
        messageIds: ['msg-1'],
        log: makeLog(t),
      }),
      /provider timeout/
    );
  });

  test('cleans up the temp session directory after the run', async (t) => {
    const fs = require('node:fs/promises');
    const path = require('node:path');
    let capturedSessionFile;
    const runEmbeddedAgent = t.mock.fn(async (params) => {
      capturedSessionFile = params.sessionFile;
      await assert.doesNotReject(fs.access(path.dirname(params.sessionFile)));
      return { payloads: [] };
    });
    const pluginRuntime = makeAgentRuntime(t, { runEmbeddedAgent });
    const { runSummarizeStep } = loadSummarize(t);

    await runSummarizeStep({
      pluginRuntime,
      spaceId: 'space-1',
      threadKey: '__main__',
      messageIds: ['msg-1'],
      log: makeLog(t),
    });

    await assert.rejects(fs.access(path.dirname(capturedSessionFile)));
  });

  test('passes botId through, so the model can recognize its own prior messages via fromAgent', async (t) => {
    const runCalls = [];
    const runEmbeddedAgent = t.mock.fn(async (params) => {
      runCalls.push(params);
      return { payloads: [] };
    });
    const pluginRuntime = makeAgentRuntime(t, { runEmbeddedAgent });
    const { runSummarizeStep } = loadSummarize(t, {
      getThread: t.mock.fn(async () => ({
        pending: [],
        processing: [
          { id: 'msg-1', senderId: 'bot-1', senderName: 'collab-agent@webex.bot', content: 'Picked this up.', botIsMentioned: false, datetime: null },
        ],
        processed: [],
      })),
    });

    await runSummarizeStep({
      pluginRuntime,
      spaceId: 'space-1',
      threadKey: '__main__',
      messageIds: ['msg-1'],
      botId: 'bot-1',
      log: makeLog(t),
    });

    assert.match(runCalls[0].prompt, /"fromAgent": true/);
    // senderName is nulled for the bot's own entries, not shown as a raw email.
    assert.ok(!runCalls[0].prompt.includes('collab-agent@webex.bot'));
  });
});

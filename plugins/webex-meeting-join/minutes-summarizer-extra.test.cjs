'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createMinutesSummarizer } = require('./minutes-summarizer');

const completeMinutes = '### Summary\nDone\n\n### Decisions\n_None recorded._\n\n### Action Items\n_None recorded._\n\n### Open Questions\n_None recorded._';

function runtimeWith(dispatch) {
  return { config: { current: () => ({ model: 'test' }) }, channel: { reply: { dispatchReplyWithBufferedBlockDispatcher: dispatch } } };
}

test('requires the dispatcher and valid identifying inputs before summarizing', async () => {
  const unavailable = createMinutesSummarizer({ runtime: {} });
  await assert.rejects(unavailable.summarize({ roomId: 'room', meetingId: 'meeting', transcript: 'text' }), /dispatch unavailable/);
  const summarizer = createMinutesSummarizer({ runtime: runtimeWith(async () => {}) });
  await assert.rejects(summarizer.summarize({ meetingId: 'meeting', transcript: 'text' }), /roomId and meetingId/);
  await assert.rejects(summarizer.summarize({ roomId: 'room', meetingId: 'meeting', transcript: '  ' }), /empty transcript/);
});

test('normalizes a single agent response and sends complete transcript evidence', async () => {
  let args;
  const summarizer = createMinutesSummarizer({ runtime: runtimeWith(async (input) => {
    args = input;
    await input.dispatcherOptions.deliver({ markdown: '```markdown\n# Meeting Minutes\n' + completeMinutes + '\n```' });
  }) });
  assert.equal(await summarizer.summarize({ roomId: 'room', meetingId: 'meeting', meeting: { topic: 'Release' }, transcript: 'Discussed release readiness.' }), completeMinutes);
  assert.match(args.ctx.Body, /<transcript>/);
  assert.match(args.ctx.Body, /Discussed release readiness/);
  assert.match(args.ctx.SessionKey, /^agent:meeting-minutes:webex:room:/);
  assert.equal(args.ctx.IsMentioned, true);
});

test('reduces each chunk before requesting final minutes from the collected evidence', async () => {
  const stages = [];
  const summarizer = createMinutesSummarizer({ runtime: runtimeWith(async (input) => {
    stages.push({ stage: input.ctx.MessageSid.split(':').at(-1), body: input.ctx.Body });
    await input.dispatcherOptions.deliver({ text: stages.length < 3 ? `note ${stages.length}` : completeMinutes });
  }), chunkChars: 12 });
  const result = await summarizer.summarize({ roomId: 'room', meetingId: 'meeting', transcript: 'first item\nsecond item' });
  assert.equal(result, completeMinutes);
  assert.deepEqual(stages.map((stage) => stage.stage), ['chunk-1', 'chunk-2', 'final']);
  assert.match(stages[0].body, /Transcript segment: 1 of 2/);
  assert.match(stages[2].body, /Segment 1:\nnote 1/);
  assert.match(stages[2].body, /Segment 2:\nnote 2/);
});

test('propagates delivery failures and rejects final output without all required sections', async () => {
  const logs = [];
  const failed = createMinutesSummarizer({ runtime: runtimeWith(async (input) => input.dispatcherOptions.onError(new Error('agent failed'))), log: { error: (message) => logs.push(message) } });
  await assert.rejects(failed.summarize({ roomId: 'room', meetingId: 'meeting', transcript: 'text' }), /agent failed/);
  assert.match(logs[0], /meeting-minutes dispatch error/);
  const incomplete = createMinutesSummarizer({ runtime: runtimeWith(async (input) => input.dispatcherOptions.deliver({ text: '### Summary\nOnly one section' })) });
  await assert.rejects(incomplete.summarize({ roomId: 'room', meetingId: 'meeting', transcript: 'text' }), /missing one or more required sections/);
});

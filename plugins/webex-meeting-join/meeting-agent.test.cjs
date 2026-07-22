'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createMeetingAgent } = require('./meeting-agent');

// A runtime whose dispatcher immediately delivers a fixed agent reply, so we can
// assert what reaches the space.
function makeRuntime(replyText, { captureCtx } = {}) {
  return {
    config: { current: () => ({}) },
    channel: {
      reply: {
        dispatchReplyWithBufferedBlockDispatcher: async ({ ctx, dispatcherOptions }) => {
          captureCtx?.(ctx);
          await dispatcherOptions.deliver({ text: replyText });
        },
      },
    },
  };
}

test('a substantive turn that clears the gate is dispatched and posted to the space', async () => {
  const posts = [];
  let seenCtx = null;
  const agent = createMeetingAgent({
    runtime: makeRuntime('You may be thinking of HTTP 404, not 401.', { captureCtx: (c) => { seenCtx = c; } }),
    postToSpace: async (roomId, markdown) => posts.push({ roomId, markdown }),
    gateThreshold: 0.6,
    minTurnWords: 5,
    scoreMessageFn: async () => ({ score: 0.8, type: 'FACTUAL_CORRECTION' }),
  });

  await agent.handleTurn({ roomId: 'room-1', meetingId: 'm-1', transcript: 'I think the auth endpoint returns 401 always' });

  assert.equal(posts.length, 1);
  assert.deepEqual(posts[0], { roomId: 'room-1', markdown: 'You may be thinking of HTTP 404, not 401.' });
  assert.equal(seenCtx.WebexRoomId, 'room-1');
  assert.equal(seenCtx.SessionKey, 'agent:meeting:webex:room-1');
});

test('trivially short turns are skipped before the gate is ever called', async () => {
  let gateCalls = 0;
  const posts = [];
  const agent = createMeetingAgent({
    runtime: makeRuntime('should not happen'),
    postToSpace: async (roomId, markdown) => posts.push({ roomId, markdown }),
    gateThreshold: 0.6,
    minTurnWords: 5,
    scoreMessageFn: async () => { gateCalls += 1; return { score: 1, type: 'CLARIFICATION' }; },
  });

  await agent.handleTurn({ roomId: 'room-1', meetingId: 'm-1', transcript: 'yeah right' });

  assert.equal(gateCalls, 0);
  assert.equal(posts.length, 0);
});

test('a turn the gate scores below threshold does not post', async () => {
  const posts = [];
  const agent = createMeetingAgent({
    runtime: makeRuntime('should not happen'),
    postToSpace: async (roomId, markdown) => posts.push({ roomId, markdown }),
    gateThreshold: 0.7,
    minTurnWords: 3,
    scoreMessageFn: async () => ({ score: 0.4, type: 'ELABORATION' }),
  });

  await agent.handleTurn({ roomId: 'room-1', meetingId: 'm-1', transcript: 'we could maybe refactor this later on' });
  assert.equal(posts.length, 0);
});

test('a NONE classification never posts even at a high score', async () => {
  const posts = [];
  const agent = createMeetingAgent({
    runtime: makeRuntime('should not happen'),
    postToSpace: async (roomId, markdown) => posts.push({ roomId, markdown }),
    gateThreshold: 0.5,
    minTurnWords: 3,
    scoreMessageFn: async () => ({ score: 0.95, type: 'NONE' }),
  });

  await agent.handleTurn({ roomId: 'room-1', meetingId: 'm-1', transcript: 'okay so anyway good chatting everyone' });
  assert.equal(posts.length, 0);
});

test('recent turns are passed to the gate as history (oldest first)', async () => {
  const seenHistories = [];
  const agent = createMeetingAgent({
    runtime: makeRuntime('noted'),
    postToSpace: async () => {},
    gateThreshold: 1.1, // never passes, so we only exercise gating context
    minTurnWords: 2,
    scoreMessageFn: async (ctx) => { seenHistories.push(ctx.recentMessages.map((m) => m.text)); return { score: 0, type: 'NONE' }; },
  });

  await agent.handleTurn({ roomId: 'room-1', meetingId: 'm-1', transcript: 'first substantive thing said' });
  await agent.handleTurn({ roomId: 'room-1', meetingId: 'm-1', transcript: 'second substantive thing said' });

  assert.deepEqual(seenHistories[0], []); // first turn has no prior history
  assert.deepEqual(seenHistories[1], ['first substantive thing said']);
});

test('an empty agent reply is not posted', async () => {
  const posts = [];
  const agent = createMeetingAgent({
    runtime: makeRuntime('   '), // whitespace-only reply
    postToSpace: async (roomId, markdown) => posts.push({ roomId, markdown }),
    gateThreshold: 0.5,
    minTurnWords: 3,
    scoreMessageFn: async () => ({ score: 0.9, type: 'BLOCKER' }),
  });

  await agent.handleTurn({ roomId: 'room-1', meetingId: 'm-1', transcript: 'I am totally blocked on the deploy step' });
  assert.equal(posts.length, 0);
});

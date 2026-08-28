'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const {
  encodeEvalSpaceId,
  isEvalSpaceId,
  buildSyntheticMessage,
  BOT_ID,
} = require('../eval/run-scenario');
const { looksLikeSpaceId } = require('../storage/paths');
const { resolveScenario } = require('../eval/gateway-method');

// ---------------------------------------------------------------------------
// Phase 8 synthetic evaluation runner — the pure helpers. The full run needs
// a live gateway runtime and is exercised via `webex.eval.run` on the
// deployment, not here.
// ---------------------------------------------------------------------------

describe('eval spaceId shaping', () => {
  test('encodeEvalSpaceId produces an id that passes looksLikeSpaceId', () => {
    const spaceId = encodeEvalSpaceId('eval-s01-release-readiness');
    assert.equal(looksLikeSpaceId(spaceId), true);
  });

  test('the decoded URN carries the :eval/ROOM/ marker so the clear guard can tell it apart', () => {
    const spaceId = encodeEvalSpaceId('eval-s01');
    const decoded = Buffer.from(spaceId, 'base64').toString('utf-8');
    assert.match(decoded, /:eval\/ROOM\//);
    assert.equal(isEvalSpaceId(spaceId), true);
  });

  test('isEvalSpaceId rejects a real-shaped space id and junk', () => {
    const real = Buffer.from('ciscospark://urn:TEAM:us-west/ROOM/abc123').toString('base64');
    assert.equal(isEvalSpaceId(real), false);
    assert.equal(isEvalSpaceId('not base64 !!!'), false);
    assert.equal(isEvalSpaceId(''), false);
  });

  test('scenario id is sanitised into the space id', () => {
    const spaceId = encodeEvalSpaceId('weird/id with spaces');
    const decoded = Buffer.from(spaceId, 'base64').toString('utf-8');
    assert.match(decoded, /:eval\/ROOM\/weird_id_with_spaces$/);
  });
});

describe('buildSyntheticMessage', () => {
  const participants = {
    Maya: { name: 'Maya', personId: 'eval-maya', email: 'maya@x.test' },
  };
  const numberToId = (n) => `s-msg-${n}`;
  const spaceId = encodeEvalSpaceId('s');

  test('maps replyTo to a Webex parentId', () => {
    const msg = buildSyntheticMessage({
      scenarioMsg: { number: 3, sender: 'Maya', text: 'hi', replyTo: 1 },
      spaceId,
      participants,
      numberToId,
    });
    assert.equal(msg.parentId, 's-msg-1');
    assert.equal(msg.id, 's-msg-3');
    assert.equal(msg.roomId, spaceId);
    assert.equal(msg.personId, 'eval-maya');
    assert.deepEqual(msg.mentionedPeople, []);
  });

  test('a top-level message has no parentId', () => {
    const msg = buildSyntheticMessage({
      scenarioMsg: { number: 1, sender: 'Maya', text: 'hi' },
      spaceId,
      participants,
      numberToId,
    });
    assert.equal('parentId' in msg, false);
  });

  test('a mention marker in the text flags the bot as mentioned', () => {
    const msg = buildSyntheticMessage({
      scenarioMsg: { number: 5, sender: 'Maya', text: '@Collaboration what is left?' },
      spaceId,
      participants,
      numberToId,
    });
    assert.deepEqual(msg.mentionedPeople, [BOT_ID]);
  });

  test('unknown senders still get a deterministic identity', () => {
    const msg = buildSyntheticMessage({
      scenarioMsg: { number: 2, sender: 'Ghost', text: 'boo' },
      spaceId,
      participants,
      numberToId,
    });
    assert.equal(msg.personId, 'ghost');
    assert.equal(msg.personEmail, 'ghost@eval.test');
    assert.equal(msg.senderName, 'Ghost');
  });
});

describe('resolveScenario (gateway method param handling)', () => {
  test('reads a bundled scenario by id', async () => {
    const scenario = await resolveScenario({ scenarioId: 'eval-s01-release-readiness' });
    assert.equal(scenario.id, 'eval-s01-release-readiness');
    assert.ok(Array.isArray(scenario.messages));
  });

  test('passes an inline scenario through unchanged', async () => {
    const inline = { id: 'x', messages: [] };
    assert.equal(await resolveScenario({ scenario: inline }), inline);
  });

  test('returns null when nothing resolves', async () => {
    assert.equal(await resolveScenario({}), null);
    assert.equal(await resolveScenario(undefined), null);
  });
});

'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { makeTempWorkspace } = require('./helpers.cjs');
const { getSpaceMembers, AGENT_ASSIGNEE } = require('../config/members');
const { writeCachedMembers } = require('../config/store');

// ---------------------------------------------------------------------------
// config/members.js — reads real, cached Webex space membership (config
// card consolidation), refreshed elsewhere (config/handle-request.js) into
// config/store.js's active.json. These tests cover the read side only:
// an empty cache, a populated one, and the always-present AGENT_ASSIGNEE
// entry.
// ---------------------------------------------------------------------------

describe('getSpaceMembers', () => {
  test('requires a spaceId', async () => {
    await assert.rejects(getSpaceMembers({}), /spaceId is required/);
  });

  test('returns just AGENT_ASSIGNEE when no members have ever been cached', async (t) => {
    const root = await makeTempWorkspace(t);

    const members = await getSpaceMembers({ spaceId: 'space-1', explicitRoot: root });

    assert.deepEqual(members, [AGENT_ASSIGNEE]);
  });

  test('returns cached members plus AGENT_ASSIGNEE', async (t) => {
    const root = await makeTempWorkspace(t);
    const cached = [
      { id: 'person-1', email: 'alice@example.com', name: 'Alice', source: 'webex' },
      { id: 'person-2', email: 'bob@example.com', name: 'Bob', source: 'override' },
    ];
    await writeCachedMembers({ spaceId: 'space-1', members: cached, explicitRoot: root });

    const members = await getSpaceMembers({ spaceId: 'space-1', explicitRoot: root });

    assert.deepEqual(members, [...cached, AGENT_ASSIGNEE]);
  });

  test('members are per-space, not shared', async (t) => {
    const root = await makeTempWorkspace(t);
    await writeCachedMembers({
      spaceId: 'space-1',
      members: [{ id: 'person-1', email: 'alice@example.com', name: 'Alice', source: 'webex' }],
      explicitRoot: root,
    });

    const spaceOne = await getSpaceMembers({ spaceId: 'space-1', explicitRoot: root });
    const spaceTwo = await getSpaceMembers({ spaceId: 'space-2', explicitRoot: root });

    assert.equal(spaceOne.length, 2);
    assert.deepEqual(spaceTwo, [AGENT_ASSIGNEE]);
  });
});

'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { getSpaceMembers, AGENT_ASSIGNEE } = require('../config/members');

// ---------------------------------------------------------------------------
// config/members.js — dummy space-member list backing the board's assignee
// dropdown. Deliberately hardcoded/placeholder (see the module's own header
// comment) ahead of a future real Webex-membership integration; these tests
// only cover the shape/contract the board depends on, not real data.
// ---------------------------------------------------------------------------

describe('getSpaceMembers', () => {
  test('requires a spaceId', async () => {
    await assert.rejects(getSpaceMembers({}), /spaceId is required/);
  });

  test('returns a non-empty dummy member list plus the special Agent entry', async () => {
    const members = await getSpaceMembers({ spaceId: 'space-1' });

    assert.ok(Array.isArray(members));
    assert.ok(members.length > 1);
    for (const member of members) {
      assert.equal(typeof member.id, 'string');
      assert.equal(typeof member.name, 'string');
    }
    assert.ok(members.some((member) => member.id === AGENT_ASSIGNEE.id));
    assert.deepEqual(
      members.find((member) => member.id === AGENT_ASSIGNEE.id),
      AGENT_ASSIGNEE
    );
  });

  test('returns the same list regardless of spaceId (dummy data, not yet space-specific)', async () => {
    const a = await getSpaceMembers({ spaceId: 'space-1' });
    const b = await getSpaceMembers({ spaceId: 'space-2' });

    assert.deepEqual(a, b);
  });
});

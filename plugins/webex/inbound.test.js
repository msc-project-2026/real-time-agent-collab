'use strict';

const { isDmAllowed, isSpaceAllowed } = require('./inbound');

function assert(condition, msg) {
  if (!condition) throw new Error(`FAIL: ${msg}`);
  console.log(`  PASS: ${msg}`);
}

function testIsDmAllowed() {
  console.log('\n--- isDmAllowed ---');

  assert(
    isDmAllowed({ dmPolicy: 'allow' }, 'any', 'any@test.com') === true,
    'allow policy permits any DM'
  );

  assert(
    isDmAllowed({ dmPolicy: 'deny' }, 'any', 'any@test.com') === false,
    'deny policy blocks all DMs'
  );

  assert(
    isDmAllowed(
      { dmPolicy: 'allowlisted', allowFrom: ['alice@test.com'] },
      'id1',
      'alice@test.com'
    ) === true,
    'allowlisted permits matching email'
  );

  assert(
    isDmAllowed(
      { dmPolicy: 'allowlisted', allowFrom: ['person-id-1'] },
      'person-id-1',
      'bob@test.com'
    ) === true,
    'allowlisted permits matching personId'
  );

  assert(
    isDmAllowed(
      { dmPolicy: 'allowlisted', allowFrom: ['alice@test.com'] },
      'id1',
      'bob@test.com'
    ) === false,
    'allowlisted blocks non-matching sender'
  );

  assert(
    isDmAllowed({}, 'any', 'any@test.com') === false,
    'undefined policy defaults to deny'
  );
}

function testIsSpaceAllowed() {
  console.log('\n--- isSpaceAllowed ---');

  assert(
    isSpaceAllowed({ spacePolicy: 'allow' }, 'any-room') === true,
    'allow policy permits any space'
  );

  assert(
    isSpaceAllowed({ spacePolicy: 'deny' }, 'any-room') === false,
    'deny policy blocks all spaces'
  );

  assert(
    isSpaceAllowed(
      { spacePolicy: 'allowlisted', allowedSpaces: ['room-abc', 'room-xyz'] },
      'room-abc'
    ) === true,
    'allowlisted permits matching space ID'
  );

  assert(
    isSpaceAllowed(
      { spacePolicy: 'allowlisted', allowedSpaces: ['room-abc', 'room-xyz'] },
      'room-other'
    ) === false,
    'allowlisted blocks non-matching space ID'
  );

  assert(
    isSpaceAllowed(
      { spacePolicy: 'allowlisted', allowedSpaces: [] },
      'room-abc'
    ) === false,
    'allowlisted with empty list blocks all spaces'
  );

  assert(
    isSpaceAllowed({}, 'any-room') === true,
    'undefined policy defaults to allow (backwards compatible)'
  );

  assert(
    isSpaceAllowed({ spacePolicy: 'allowlisted' }, 'room-abc') === false,
    'allowlisted with missing allowedSpaces blocks all'
  );
}

try {
  testIsDmAllowed();
  testIsSpaceAllowed();
  console.log('\nAll tests passed.\n');
} catch (e) {
  console.error(e.message);
  process.exit(1);
}

// ********* CONFIG/MEMBERS.JS *********
'use strict';

// Dummy space-member list backing the board's assignee dropdown
// (board/src/App.jsx). Real member data will eventually come from the
// space's active config (config/store.js) — a future, larger update that
// fetches actual Webex space membership (once, at config/setup time,
// cached the same way active.json already caches project config) and
// builds an email<->name mapping the model could also use to refer to
// people by name instead of raw email addresses. For now this is a fixed
// placeholder list, identical for every space, not wired into the config
// card (config/card.js) at all.

const DUMMY_MEMBERS = [
  { id: 'alice@example.com', name: 'Alice' },
  { id: 'bob@example.com', name: 'Bob' },
  { id: 'carol@example.com', name: 'Carol' },
];

// Special assignee entry representing "the agent should do this" — distinct
// from a human member, and the trigger for the board's delegate control
// (board/src/App.jsx: delegation only makes sense once assigned === 'agent').
const AGENT_ASSIGNEE = { id: 'agent', name: 'Agent' };

async function getSpaceMembers({ spaceId }) {
  if (!spaceId) throw new Error('spaceId is required');

  // TODO(future): read from readActiveConfig({ spaceId }) once the config
  // card actually collects real space membership; for now every space gets
  // the same dummy list regardless of spaceId.
  return [...DUMMY_MEMBERS, AGENT_ASSIGNEE];
}

module.exports = {
  getSpaceMembers,
  AGENT_ASSIGNEE,
};

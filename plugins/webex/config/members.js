// ********* CONFIG/MEMBERS.JS *********
'use strict';

// Backs the board's assignee dropdown (board/src/App.jsx) and the config
// card's per-member name mapping (config/card.js). Real Webex membership,
// cached in config/store.js's active.json alongside (but independent of)
// the space's submitted configuration — refreshed on every config-request
// (config/handle-request.js), not fetched live here.

const { readActiveConfig } = require('./store');

// Special assignee entry representing "the agent should do this" — distinct
// from a human member, and the trigger for the board's delegate control
// (board/src/App.jsx: delegation only makes sense once assigned === 'agent').
const AGENT_ASSIGNEE = { id: 'agent', name: 'Agent' };

async function getSpaceMembers({ spaceId, explicitRoot }) {
  if (!spaceId) throw new Error('spaceId is required');

  const activeConfig = await readActiveConfig({ spaceId, explicitRoot });
  const members = Array.isArray(activeConfig?.members) ? activeConfig.members : [];

  return [...members, AGENT_ASSIGNEE];
}

module.exports = {
  getSpaceMembers,
  AGENT_ASSIGNEE,
};

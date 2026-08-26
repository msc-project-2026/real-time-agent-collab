// ********* CONFIG/HANDLE-REQUEST.JS *********
'use strict';

const { webexFetch } = require('../api');
const { readActiveConfig, writeCachedMembers } = require('./store');
const { sendConfigCard } = require('./card');

// Refreshes the cached member list from Webex's own membership roster —
// the one place this happens, since opening the config card is already the
// natural "someone's actively engaging with setup" moment (no separate
// cron/trigger needed). `email` always comes from the fresh fetch — it's a
// Webex identity fact, never human-editable. `name` keeps a prior
// `source: 'override'` value untouched; anything else refreshes from
// Webex's own `personDisplayName` (falling back to email if Webex has
// none). A fetch failure falls back to whatever's already cached rather
// than blocking the card entirely.
async function refreshCachedMembers({ spaceId, account, log }) {
  const token = account?.config?.token;
  const existing = (await readActiveConfig({ spaceId }))?.members ?? [];

  if (!token) return existing;

  let memberships;
  try {
    const response = await webexFetch(token, `/memberships?roomId=${encodeURIComponent(spaceId)}`);
    memberships = Array.isArray(response?.items) ? response.items : [];
  } catch (err) {
    log?.warn?.(
      `[collab-agent:config-request] failed to fetch space memberships ${JSON.stringify({
        spaceId,
        error: err?.message ?? String(err),
      })}`
    );
    return existing;
  }

  const existingById = new Map(existing.map((member) => [member.id, member]));

  const merged = memberships
    .filter((membership) => membership.personId)
    .map((membership) => {
      const prior = existingById.get(membership.personId);
      const isOverride = prior?.source === 'override';

      return {
        id: membership.personId,
        email: membership.personEmail ?? prior?.email ?? null,
        name: isOverride
          ? prior.name
          : membership.personDisplayName ?? membership.personEmail ?? membership.personId,
        source: isOverride ? 'override' : 'webex',
      };
    });

  await writeCachedMembers({ spaceId, members: merged });

  return merged;
}

// Handler
async function handleConfigRequest({ spaceId, threadKey, message, account, botId, log, sendFn }) {
  if (!spaceId) throw new Error('spaceId is required');
  if (!account) throw new Error('account is required');

  const activeConfig = await readActiveConfig({ spaceId });
  const members = await refreshCachedMembers({ spaceId, account, log });

  log?.info?.(
    `[collab-agent:config-request] handling config request ${JSON.stringify({
      spaceId,
      hasActiveConfig: Boolean(activeConfig),
      memberCount: members.length,
    })}`
  );

  await sendConfigCard({
    spaceId,
    threadKey,
    message,
    account,
    botId,
    log,
    config: activeConfig?.config ?? {},
    members,
    sendFn,
  });
}

module.exports = {
  handleConfigRequest,
};

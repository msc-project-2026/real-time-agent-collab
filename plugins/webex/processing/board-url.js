// ********* PROCESSING/BOARD-URL.JS *********
'use strict';

// Shared by respond/dispatch.js and task-notify.js — both need to link back
// to this space's board. The model/deterministic code has no way to know
// the board's URL on its own — it's not something that should ever be
// guessed or fabricated. Derived from the account's own webhook URL (the
// one piece of config that reliably carries the deployment's public host)
// rather than requiring new config. Returns null if it can't be derived
// (e.g. account/config missing in a test double) — callers omit the fact
// entirely rather than showing a broken link.
function deriveBoardUrl({ account, spaceId }) {
  const webhookUrl = account?.config?.botWebhookUrl;
  if (!webhookUrl) return null;

  try {
    const origin = new URL(webhookUrl).origin;
    return `${origin}/webex/collab/board?spaceId=${encodeURIComponent(spaceId)}`;
  } catch {
    return null;
  }
}

module.exports = {
  deriveBoardUrl,
};

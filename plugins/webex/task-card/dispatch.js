// ********* TASK-CARD/DISPATCH.JS *********
'use strict';

// Thin send wrapper, same shape as config/card.js's sendConfigCard — builds
// the card (./card) and sends it via the shared card infrastructure
// (card/shared.js). Kept separate from ./card so a future submission handler
// (handle-submission.js, mirroring config's) can sit alongside it without
// crowding the pure card-building module.

const { sendWebexMessage } = require('../send');
const { sendAdaptiveCard } = require('../card/shared');
const { buildTaskApprovalCard } = require('./card');

async function sendTaskApprovalCard({
  task,
  boardUrl,
  spaceId,
  account,
  log,
  parentId,
  sendFn = sendWebexMessage,
}) {
  if (!task) throw new Error('task is required');

  const card = buildTaskApprovalCard({ task, boardUrl });

  return sendAdaptiveCard({
    spaceId,
    account,
    log,
    markdown: `New task pending approval: **${task.title}**`,
    card,
    parentId,
    sendFn,
  });
}

module.exports = {
  sendTaskApprovalCard,
};

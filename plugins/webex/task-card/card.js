// ********* TASK-CARD/CARD.JS *********
'use strict';

// Deterministic Adaptive Card builder for a self-assigned task that didn't
// clear the confidence auto-approval bar (processing/task-notify.js) — same
// pattern as config/card.js's buildConfigCard, built on the same shared
// card infrastructure (card/shared.js). Approve/Reject buttons are
// intentionally not wired to a handler yet; inbound/attachment-actions.js's
// `default` case already fails safe (logs and returns) for any action type
// it doesn't recognize, so sending these now, unwired, is safe. Submission
// handling (approve/reject) is future work — this directory is where it'll
// live, mirroring config/'s card.js + handle-request.js + handle-submission.js
// split.

const { valueOrEmpty } = require('../card/shared');

function buildTaskApprovalCard({ task, boardUrl }) {
  const body = [
    {
      type: 'TextBlock',
      text: `New task pending approval: ${valueOrEmpty(task.title)}`,
      weight: 'Bolder',
      size: 'Medium',
      wrap: true,
    },
  ];

  if (task.description) {
    body.push({
      type: 'TextBlock',
      text: task.description,
      wrap: true,
      spacing: 'Small',
    });
  }

  body.push({
    type: 'FactSet',
    facts: [
      { title: 'Type', value: valueOrEmpty(task.type) },
      {
        title: 'Confidence',
        value: typeof task.confidence === 'number' ? String(task.confidence) : 'n/a',
      },
    ],
  });

  if (boardUrl) {
    body.push({
      type: 'TextBlock',
      text: `[View on board](${boardUrl})`,
      wrap: true,
      spacing: 'Small',
    });
  }

  return {
    type: 'AdaptiveCard',
    version: '1.3',
    body,
    actions: [
      {
        type: 'Action.Submit',
        title: '✓ Approve',
        data: { action: 'task_card_approve', taskId: task.id },
      },
      {
        type: 'Action.Submit',
        title: '✗ Reject',
        data: { action: 'task_card_reject', taskId: task.id },
      },
    ],
  };
}

module.exports = {
  buildTaskApprovalCard,
};

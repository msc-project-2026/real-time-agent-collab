// ********* PROCESSING/TASK-NOTIFY.JS *********
'use strict';

// v3 response-policy + extraction-calibration revision — deterministic, no
// model spawn at all (unlike respond/extract/summarize, no dispatch/
// instruction/tool triad needed here). Runs in run-message-flow.js after
// extract has settled, since it reads what extract just wrote.
//
// Silent for human-assigned (or unassigned) tasks — this is the direct fix
// for the reported bug where respond narrated an already-extracted,
// human-assigned task unprompted. For an agent-assigned task touched this
// batch: an ack message if it just cleared the confidence auto-approval bar
// (extract/tool.js already set status: 'in_progress' + delegation there),
// or a pending-approval Adaptive Card if it's newly created and still
// awaiting approval (task-card/card.js).
//
// Each notified entry also reports `coversLastMessage` — whether that
// specific task's evidence includes the batch's last-arrived message, the
// only one that could have triggered `shouldRespond` (see
// run-message-flow.js). This has no bearing on which tasks get notified
// (that's the filtering above, over the whole batch); it's purely a signal
// the caller reads afterward to decide whether `respond` should be skipped.
//
// The two branches use different "did this just happen" signals, since a
// single `createdAt === updatedAt` check isn't right for both:
// - Card (still pending): fires only on creation — a task patched again
//   while still unapproved (e.g. more evidence added) must NOT re-send a
//   card every time it's touched.
// - Ack (auto-approved): fires whenever `delegation.delegatedAt` falls
//   within *this* extract step's run, regardless of whether the override
//   fired on creation or a later patch — otherwise a task that starts below
//   the confidence bar and only crosses it on a subsequent patch would
//   silently flip to in_progress+delegated with no ack ever sent, since by
//   then createdAt no longer equals updatedAt.
const { getTasks } = require('../storage/tasks-store');
const { sendWebexMessage, sendOutboundMessage, resolveReplyThreadId } = require('../send');
const { deriveBoardUrl } = require('./board-url');
const { sendTaskApprovalCard } = require('../task-card/card');

function isNewlyCreatedPendingTask(task) {
  return task.assigned === 'agent' && task.status !== 'in_progress' && task.createdAt === task.updatedAt;
}

function wasJustDelegated(task, sinceTimestamp) {
  return (
    task.assigned === 'agent' &&
    task.status === 'in_progress' &&
    Boolean(task.delegation?.delegatedAt) &&
    (!sinceTimestamp || task.delegation.delegatedAt >= sinceTimestamp)
  );
}

function buildAckText({ task, boardUrl }) {
  const target = task.delegation?.target ?? 'the swarm';
  const link = boardUrl ? ` ${boardUrl}` : '';
  return `Picked this up — **${task.title}**, now in progress, delegated to ${target}.${link}`;
}

async function runTaskNotifyStep({
  spaceId,
  threadKey,
  messageIds,
  message,
  isBotMentioned,
  account,
  botId,
  log,
  sendFn = sendWebexMessage,
  sinceTimestamp,
  explicitRoot,
}) {
  if (!spaceId) throw new Error('spaceId is required');
  if (!threadKey) throw new Error('threadKey is required');
  if (!Array.isArray(messageIds)) throw new Error('messageIds array is required');

  const tasks = await getTasks({ spaceId, messageIds, explicitRoot });
  const notifyWorthy = tasks.filter(
    (task) => isNewlyCreatedPendingTask(task) || wasJustDelegated(task, sinceTimestamp)
  );

  if (notifyWorthy.length === 0) {
    return { outcome: 'success', notified: [] };
  }

  const token = account?.config?.token;
  if (!token) {
    log?.warn?.('[collab-agent:task-notify] no Webex token available, skipping notification');
    return { outcome: 'success', notified: [] };
  }

  const replyThreadId = await resolveReplyThreadId({
    spaceId,
    explicitRoot,
    threadKey,
    message,
    isBotMentioned,
  });
  const boardUrl = deriveBoardUrl({ account, spaceId });
  const fetchMessageById = async () => message;
  // Only the last-arrived message in the batch could possibly be the one
  // responsible for shouldRespond (see run-message-flow.js's respond-skip
  // logic) — checked per task below, never assumed from just one.
  const lastMessageId = messageIds[messageIds.length - 1];

  const notified = [];

  for (const task of notifyWorthy) {
    const coversLastMessage = task.message_ids.includes(lastMessageId);

    if (task.status === 'in_progress') {
      await sendOutboundMessage({
        sendFn,
        spaceId,
        botId,
        fetchMessageById,
        log,
        token,
        to: spaceId,
        markdown: buildAckText({ task, boardUrl }),
        parentId: replyThreadId,
      });
      notified.push({ taskId: task.id, action: 'ack', coversLastMessage });
    } else {
      await sendTaskApprovalCard({
        task,
        boardUrl,
        spaceId,
        account,
        botId,
        log,
        parentId: replyThreadId,
        fetchMessageById,
        sendFn,
      });
      notified.push({ taskId: task.id, action: 'approval_card', coversLastMessage });
    }
  }

  log?.info?.(
    `[collab-agent:task-notify] task-notify step completed ${JSON.stringify({
      spaceId,
      threadKey,
      notified,
    })}`
  );

  return { outcome: 'success', notified };
}

module.exports = {
  runTaskNotifyStep,
};

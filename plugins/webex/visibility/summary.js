// ********* VISIBILITY/SUMMARY.JS *********
'use strict';

const { getTasks } = require('../storage/tasks-store');
const { getThreads } = require('../storage/threads-store');
const { asArray } = require('../utils/normalise');

function countTasks(tasks, predicate) {
  return asArray(tasks).filter(predicate).length;
}

function formatTaskForVisibility(task) {
  return {
    id: task.id,
    title: task.title,
    description: task.description,
    type: task.type,
    status: task.status,
    assigned: task.assigned ?? null,
    deadline: task.deadline ?? null,
    message_ids: task.message_ids ?? [],
    child_tasks: task.child_tasks ?? [],
    createdAt: task.createdAt ?? null,
    updatedAt: task.updatedAt ?? null,
  };
}

function formatThreadForVisibility(thread) {
  return {
    key: thread.key,
    kind: thread.kind,
    rootMessageId: thread.rootMessageId ?? null,
    pendingCount: Array.isArray(thread.pending) ? thread.pending.length : 0,
    processingCount: Array.isArray(thread.processing) ? thread.processing.length : 0,
    processedCount: Array.isArray(thread.processed) ? thread.processed.length : 0,
    updatedAt: thread.updatedAt ?? null,
  };
}

async function buildContextSummary({ spaceId }) {
  if (!spaceId) throw new Error('spaceId is required');

  const tasks = await getTasks({
    spaceId,
    limit: 200,
  });

  const threads = await getThreads({
    spaceId,
    limit: 100,
  });

  return {
    spaceId,
    generatedAt: new Date().toISOString(),
    counts: {
      unapprovedTasks: countTasks(tasks, (task) => task.status === 'unapproved'),
      backlogTasks: countTasks(tasks, (task) => task.status === 'backlog'),
      inProgressTasks: countTasks(tasks, (task) => task.status === 'in_progress'),
      inReviewTasks: countTasks(tasks, (task) => task.status === 'in_review'),
      doneTasks: countTasks(tasks, (task) => task.status === 'done'),
      archivedTasks: countTasks(tasks, (task) => task.status === 'archived'),
    },
    tasks: tasks.map(formatTaskForVisibility),
    threads: threads.map(formatThreadForVisibility),
  };
}

module.exports = {
  buildContextSummary,
};

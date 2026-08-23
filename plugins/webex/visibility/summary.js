// ********* VISIBILITY/SUMMARY.JS *********
'use strict';

const { getTasks } = require('../context/tasks-store');
const { getThreads } = require('../context/threads-store');
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
    contextWindowSize: Array.isArray(thread.contextWindow)
      ? thread.contextWindow.length
      : 0,
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
      openTasks: countTasks(tasks, (task) => task.status === 'open'),
      approvedTasks: countTasks(tasks, (task) => task.status === 'approved'),
      delegatedTasks: countTasks(tasks, (task) => task.status === 'delegated'),
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

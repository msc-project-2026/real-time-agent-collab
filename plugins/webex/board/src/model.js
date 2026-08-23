export function shortId(id) {
  if (!id) return '—';
  return String(id).slice(0, 8);
}

export function formatDate(ts) {
  if (!ts) return '—';
  try {
    return new Date(ts).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return String(ts);
  }
}

// v3 §7c task record, normalized for display. Single status axis
// (open/approved/delegated/done/archived) — no separate approvalStatus or
// delegationStatus, those were a v2-items-schema simulation of what the
// task enum already encodes directly.
export function normalizeTask(task) {
  return {
    ...task,
    title: task.title || '(untitled)',
    description: task.description ?? '',
    type: task.type ?? 'development',
    status: task.status ?? 'open',
    assigned: task.assigned ?? 'unknown',
    deadline: task.deadline ?? 'unknown',
    message_ids: task.message_ids ?? [],
    child_tasks: task.child_tasks ?? [],
  };
}

export function isReviewTask(task) {
  return task.status === 'open';
}

export function filterTasks(
  tasks,
  { search = '', typeFilter = '', statusFilter = '' } = {}
) {
  const query = search.toLowerCase();

  return tasks
    .filter((task) => {
      if (typeFilter && task.type !== typeFilter) return false;
      if (statusFilter && task.status !== statusFilter) return false;
      if (query) {
        return (
          task.title?.toLowerCase().includes(query) ||
          task.description?.toLowerCase().includes(query) ||
          task.assigned?.toLowerCase().includes(query)
        );
      }
      return true;
    })
    .sort((a, b) => {
      const aTime = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
      const bTime = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
      return bTime - aTime;
    });
}

export function buildBoardCounts(tasks) {
  return {
    total: tasks.length,
    open: tasks.filter((task) => task.status === 'open').length,
    approved: tasks.filter((task) => task.status === 'approved').length,
    delegated: tasks.filter((task) => task.status === 'delegated').length,
    done: tasks.filter((task) => task.status === 'done').length,
    archived: tasks.filter((task) => task.status === 'archived').length,
  };
}

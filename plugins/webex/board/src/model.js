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

// v3 §7c task record, normalized for display. Single status axis — board-
// workflow revision: `unapproved` (pre-approval, Review Queue) plus a
// traditional post-approval pipeline (backlog/in_progress/in_review/done),
// `archived` unchanged. `delegated` is no longer a status value; delegation
// (target + timestamp) is board-local-only state added directly in App.jsx,
// never normalized here since it never comes from the backend.
export function normalizeTask(task) {
  return {
    ...task,
    title: task.title || '(untitled)',
    description: task.description ?? '',
    type: task.type ?? 'development',
    status: task.status ?? 'unapproved',
    assigned: task.assigned ?? 'unknown',
    deadline: task.deadline ?? 'unknown',
    message_ids: task.message_ids ?? [],
    child_tasks: task.child_tasks ?? [],
  };
}

export function isReviewTask(task) {
  return task.status === 'unapproved';
}

// Resolves an `assigned` id (a member id/email, the special 'agent' id, or
// the 'unknown' sentinel) to a display name. Falls back to the raw id for a
// value that doesn't match any known member — e.g. a raw email the model
// captured that isn't in the (currently dummy) member list — so an
// unrecognized value is still shown rather than silently blanked.
export function resolveAssigneeName(assigned, members = []) {
  if (!assigned || assigned === 'unknown') return 'Unassigned';
  return members.find((member) => member.id === assigned)?.name ?? assigned;
}

export function filterTasks(
  tasks,
  { search = '', typeFilter = '', statusFilter = '', members = [] } = {}
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
          task.assigned?.toLowerCase().includes(query) ||
          resolveAssigneeName(task.assigned, members).toLowerCase().includes(query)
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
    unapproved: tasks.filter((task) => task.status === 'unapproved').length,
    backlog: tasks.filter((task) => task.status === 'backlog').length,
    inProgress: tasks.filter((task) => task.status === 'in_progress').length,
    inReview: tasks.filter((task) => task.status === 'in_review').length,
    done: tasks.filter((task) => task.status === 'done').length,
    archived: tasks.filter((task) => task.status === 'archived').length,
  };
}

// -- Deadline date-picker helpers --------------------------------------------
// deadline stays an opaque string on the model-facing side ('unknown' or a
// date string) — these only convert to/from what a native
// <input type="date"> needs (a plain 'YYYY-MM-DD', or '' for empty/unset).

const DATE_INPUT_PATTERN = /^\d{4}-\d{2}-\d{2}/;

export function toDateInputValue(deadline) {
  if (!deadline || deadline === 'unknown') return '';
  const match = DATE_INPUT_PATTERN.exec(deadline);
  return match ? match[0] : '';
}

export function fromDateInputValue(value) {
  return value ? value : 'unknown';
}

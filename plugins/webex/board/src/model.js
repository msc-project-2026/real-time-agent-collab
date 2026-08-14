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

export function isWorkItem(item) {
  return item.type === 'task' || item.type === 'issue';
}

export function normalizeItem(item) {
  return {
    ...item,
    title: item.title ?? '(untitled)',
    approvalStatus: item.approvalStatus ?? 'proposed',
    assignee: item.assignee ?? item.owner ?? '',
    assigneeType: item.assigneeType ?? null,
    delegationStatus: item.delegationStatus ?? 'not_delegated',
  };
}

export function filterProjectItems(
  items,
  { search = '', typeFilter = '', statusFilter = '' } = {}
) {
  const query = search.toLowerCase();

  return items
    .filter((item) => {
      if (typeFilter && item.type !== typeFilter) return false;
      if (statusFilter && item.status !== statusFilter) return false;
      if (query) {
        return (
          item.title?.toLowerCase().includes(query) ||
          item.description?.toLowerCase().includes(query) ||
          item.owner?.toLowerCase().includes(query)
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

export function buildBoardCounts(items) {
  return {
    total: items.length,
    proposed: items.filter((item) => item.approvalStatus === 'proposed').length,
    approved: items.filter((item) => item.approvalStatus === 'approved').length,
    open: items.filter((item) => item.status === 'open').length,
    in_progress: items.filter((item) => item.status === 'in_progress').length,
    blocked: items.filter((item) => item.status === 'blocked').length,
    resolved: items.filter((item) => item.status === 'resolved').length,
    risks: items.filter((item) => item.type === 'risk').length,
    decisions: items.filter((item) => item.type === 'decision').length,
  };
}

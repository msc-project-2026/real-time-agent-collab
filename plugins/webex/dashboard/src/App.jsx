import { useState, useEffect, useCallback } from 'react';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function shortId(id) {
  if (!id) return '—';
  return String(id).slice(0, 8);
}

function formatDate(ts) {
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

function isWorkItem(item) {
  return item.type === 'task' || item.type === 'issue';
}

function normalizeItem(item) {
  return {
    ...item,
    title: item.title ?? '(untitled)',
    approvalStatus: item.approvalStatus ?? 'proposed',
    assignee: item.assignee ?? item.owner ?? '',
    assigneeType: item.assigneeType ?? null,
    delegationStatus: item.delegationStatus ?? 'not_delegated',
  };
}

// ─── Constants ────────────────────────────────────────────────────────────────

const TYPE_LABELS = {
  task: 'Task',
  issue: 'Issue',
  question: 'Question',
  decision: 'Decision',
  risk: 'Risk',
  dependency: 'Dependency',
  coordination: 'Coordination',
};

const STATUS_LABELS = {
  open: 'Open',
  in_progress: 'In Progress',
  blocked: 'Blocked',
  resolved: 'Resolved',
  stale: 'Stale',
};

const WORK_STATUSES = ['open', 'in_progress', 'blocked', 'resolved', 'stale'];
const NON_WORK_TYPES = ['question', 'decision', 'risk', 'dependency', 'coordination'];

// ─── Badges ──────────────────────────────────────────────────────────────────

function TypeBadge({ type }) {
  return (
    <span className={`badge type-${type}`}>
      {TYPE_LABELS[type] ?? type}
    </span>
  );
}

function StatusBadge({ status }) {
  const cls = status ? status.replace(/_/g, '-') : 'unknown';
  return (
    <span className={`badge status-${cls}`}>
      {STATUS_LABELS[status] ?? status ?? '—'}
    </span>
  );
}

function ApprovalBadge({ status }) {
  return (
    <span className={`badge approval-${status ?? 'unknown'}`}>
      {status ?? '—'}
    </span>
  );
}

function DelegationBadge({ status }) {
  const cls = status ? status.replace(/_/g, '-') : 'unknown';
  const label = status ? status.replace(/_/g, ' ') : '—';
  return (
    <span className={`badge delegation-${cls}`}>{label}</span>
  );
}

// ─── Summary Card ─────────────────────────────────────────────────────────────

function SummaryCard({ label, value, accent }) {
  return (
    <div className={`summary-card${accent ? ` summary-${accent}` : ''}`}>
      <span className="summary-val">{value}</span>
      <span className="summary-label">{label}</span>
    </div>
  );
}

// ─── Edit Form ────────────────────────────────────────────────────────────────

function EditForm({ item, isWorkItem: isWork, onSave, onCancel }) {
  const [title, setTitle] = useState(item.title ?? '');
  const [description, setDescription] = useState(item.description ?? '');
  const [status, setStatus] = useState(item.status ?? 'open');
  const [assignee, setAssignee] = useState(item.assignee ?? '');
  const [owner, setOwner] = useState(item.owner ?? '');

  function handleSave() {
    onSave({ title, description, status, assignee, owner });
  }

  return (
    <div className="edit-form">
      <div className="edit-form-field">
        <label>Title</label>
        <input value={title} onChange={e => setTitle(e.target.value)} />
      </div>
      <div className="edit-form-field">
        <label>Description</label>
        <textarea rows={3} value={description} onChange={e => setDescription(e.target.value)} />
      </div>
      <div className="edit-form-row">
        <div className="edit-form-field">
          <label>Status</label>
          <select value={status} onChange={e => setStatus(e.target.value)}>
            {WORK_STATUSES.map(s => (
              <option key={s} value={s}>{STATUS_LABELS[s]}</option>
            ))}
          </select>
        </div>
        <div className="edit-form-field">
          <label>{isWork ? 'Assignee' : 'Owner'}</label>
          {isWork
            ? <input value={assignee} onChange={e => setAssignee(e.target.value)} />
            : <input value={owner} onChange={e => setOwner(e.target.value)} />
          }
        </div>
      </div>
      <div className="edit-form-actions">
        <span className="local-note">⚠ Local only — resets on refresh</span>
        <button className="btn btn-primary" onClick={handleSave}>Save</button>
        <button className="btn btn-ghost" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

// ─── Review Card ─────────────────────────────────────────────────────────────

function ReviewCard({ item, editingId, onApprove, onReject, onEdit, onEditSave, onEditCancel }) {
  const isEditing = editingId === item.id;

  return (
    <div className={`card${isEditing ? ' card-editing' : ''}`}>
      <div className="card-header">
        <div className="card-badges">
          <TypeBadge type={item.type} />
          <StatusBadge status={item.status} />
        </div>
        {item.updatedAt && <span className="card-time">{formatDate(item.updatedAt)}</span>}
      </div>

      {isEditing ? (
        <EditForm item={item} isWorkItem onSave={onEditSave} onCancel={onEditCancel} />
      ) : (
        <>
          <h3 className="card-title">{item.title}</h3>
          {item.description && <p className="card-description">{item.description}</p>}
          <div className="card-meta">
            <span className="meta-item">
              {item.assignee ? `👤 ${item.assignee}` : 'Unassigned'}
            </span>
            {item.evidenceMessageIds?.length > 0 && (
              <span className="meta-item">📎 {item.evidenceMessageIds.length} evidence</span>
            )}
            {item.conversationIds?.length > 0 && (
              <span className="meta-item">
                💬 {item.conversationIds.length} convo{item.conversationIds.length !== 1 ? 's' : ''}
              </span>
            )}
          </div>
          <div className="card-actions">
            <button className="btn btn-approve" onClick={onApprove}>✓ Approve</button>
            <button className="btn btn-reject" onClick={onReject}>✗ Reject</button>
            <button className="btn btn-ghost btn-sm" onClick={onEdit}>Edit</button>
          </div>
        </>
      )}
    </div>
  );
}

// ─── Work Card ────────────────────────────────────────────────────────────────

function WorkCard({ item, editingId, onEdit, onEditSave, onEditCancel, onStatusChange, onDelegate, onMarkResolved }) {
  const isEditing = editingId === item.id;

  return (
    <div className={`card${isEditing ? ' card-editing' : ''}`}>
      <div className="card-header">
        <div className="card-badges">
          <TypeBadge type={item.type} />
          <ApprovalBadge status={item.approvalStatus} />
        </div>
        {item.updatedAt && <span className="card-time">{formatDate(item.updatedAt)}</span>}
      </div>

      {isEditing ? (
        <EditForm item={item} isWorkItem onSave={onEditSave} onCancel={onEditCancel} />
      ) : (
        <>
          <h3 className="card-title">{item.title}</h3>
          <div className="card-meta">
            <span className="meta-item">
              {item.assignee ? `👤 ${item.assignee}` : 'Unassigned'}
            </span>
            <DelegationBadge status={item.delegationStatus} />
          </div>
          {item.description && <p className="card-description">{item.description}</p>}
          <div className="card-actions work-card-actions">
            <div className="card-actions-row">
              <select
                className="status-select"
                value={item.status}
                onChange={e => onStatusChange(e.target.value)}
              >
                {WORK_STATUSES.map(s => (
                  <option key={s} value={s}>{STATUS_LABELS[s]}</option>
                ))}
              </select>
              <button className="btn btn-ghost btn-sm" onClick={onEdit}>Edit</button>
            </div>
            <div className="card-actions-row">
              {item.delegationStatus === 'not_delegated' ? (
                <button className="btn btn-delegate btn-sm" onClick={onDelegate}>
                  Queue Delegate (local)
                </button>
              ) : (
                <span className="local-note-inline">
                  ⏳ Delegation {item.delegationStatus.replace(/_/g, ' ')} (local)
                </span>
              )}
              {item.status !== 'resolved' && (
                <button className="btn btn-resolve btn-sm" onClick={onMarkResolved}>
                  Mark Resolved (local)
                </button>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ─── Project Record ───────────────────────────────────────────────────────────

function ProjectRecord({ items, editingId, onEdit, onEditSave, onEditCancel }) {
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');

  const filtered = items
    .filter(item => {
      if (typeFilter && item.type !== typeFilter) return false;
      if (statusFilter && item.status !== statusFilter) return false;
      if (search) {
        const q = search.toLowerCase();
        return (
          item.title?.toLowerCase().includes(q) ||
          item.description?.toLowerCase().includes(q) ||
          item.owner?.toLowerCase().includes(q)
        );
      }
      return true;
    })
    .sort((a, b) => {
      const da = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
      const db = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
      return db - da;
    });

  return (
    <div>
      <div className="record-controls">
        <input
          className="search-input"
          type="search"
          placeholder="Search title, description, owner…"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        <select value={typeFilter} onChange={e => setTypeFilter(e.target.value)}>
          <option value="">All types</option>
          {NON_WORK_TYPES.map(t => (
            <option key={t} value={t}>{TYPE_LABELS[t]}</option>
          ))}
        </select>
        <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
          <option value="">All statuses</option>
          {WORK_STATUSES.map(s => (
            <option key={s} value={s}>{STATUS_LABELS[s]}</option>
          ))}
        </select>
        <span className="record-count">{filtered.length} / {items.length} items</span>
      </div>

      <div className="record-table-wrap">
        <table className="record-table">
          <thead>
            <tr>
              <th>Type</th>
              <th>Title</th>
              <th>Status</th>
              <th>Owner</th>
              <th>Updated</th>
              <th>Evidence</th>
              <th>Description</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr>
                <td colSpan={8} className="table-empty">
                  {items.length === 0 ? 'No project record items.' : 'No items match the current filters.'}
                </td>
              </tr>
            )}
            {filtered.map(item =>
              editingId === item.id ? (
                <tr key={item.id} className="tr-editing">
                  <td colSpan={8}>
                    <EditForm
                      item={item}
                      isWorkItem={false}
                      onSave={form => onEditSave(item.id, form)}
                      onCancel={onEditCancel}
                    />
                  </td>
                </tr>
              ) : (
                <tr key={item.id}>
                  <td><TypeBadge type={item.type} /></td>
                  <td className="td-title">{item.title}</td>
                  <td><StatusBadge status={item.status} /></td>
                  <td>{item.owner || '—'}</td>
                  <td className="td-date">{formatDate(item.updatedAt)}</td>
                  <td className="td-center">{item.evidenceMessageIds?.length ?? 0}</td>
                  <td className="td-desc">{item.description || '—'}</td>
                  <td>
                    <button className="btn btn-ghost btn-sm" onClick={() => onEdit(item)}>Edit</button>
                  </td>
                </tr>
              )
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── App ──────────────────────────────────────────────────────────────────────

export default function App() {
  const spaceId = new URLSearchParams(window.location.search).get('spaceId') ?? '';

  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [lastLoaded, setLastLoaded] = useState(null);
  const [activeTab, setActiveTab] = useState('review');
  const [editingId, setEditingId] = useState(null);

  const fetchItems = useCallback(async () => {
    if (!spaceId) {
      setError('No spaceId in URL. Expected: ?spaceId=<id>');
      return;
    }
    setLoading(true);
    setError(null);
    setEditingId(null);
    try {
      const url = `/webex/collab/spaces/${encodeURIComponent(spaceId)}/items`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      const data = await res.json();
      const rawItems = Array.isArray(data) ? data : (data.items ?? []);
      setItems(rawItems.map(normalizeItem));
      setLastLoaded(new Date());
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [spaceId]);

  useEffect(() => { fetchItems(); }, [fetchItems]);

  function updateItem(id, patch) {
    setItems(prev => prev.map(item => item.id === id ? { ...item, ...patch } : item));
  }

  function handleEditSave(id, form, isWork) {
    const patch = {
      title: form.title,
      description: form.description,
      status: form.status,
    };
    if (isWork) {
      patch.assignee = form.assignee ?? '';
    } else {
      patch.owner = form.owner ?? '';
    }
    updateItem(id, patch);
    setEditingId(null);
  }

  // Derived slices
  const workItems = items.filter(isWorkItem);
  const reviewItems = workItems.filter(i => i.approvalStatus === 'proposed');
  const boardItems = workItems.filter(i => i.approvalStatus === 'approved');
  const recordItems = items.filter(i => !isWorkItem(i));

  const counts = {
    total: items.length,
    proposed: items.filter(i => i.approvalStatus === 'proposed').length,
    approved: items.filter(i => i.approvalStatus === 'approved').length,
    open: items.filter(i => i.status === 'open').length,
    in_progress: items.filter(i => i.status === 'in_progress').length,
    blocked: items.filter(i => i.status === 'blocked').length,
    resolved: items.filter(i => i.status === 'resolved').length,
    risks: items.filter(i => i.type === 'risk').length,
    decisions: items.filter(i => i.type === 'decision').length,
  };

  return (
    <div className="app">
      {/* Header */}
      <header className="app-header">
        <div className="header-left">
          <h1>Project Items Dashboard</h1>
          {spaceId && (
            <span className="header-spaceid" title={spaceId}>
              Space: {shortId(spaceId)}…
            </span>
          )}
          <span className="local-disclaimer">Changes are local — refresh resets to backend state</span>
        </div>
        <div className="header-right">
          {lastLoaded && (
            <span className="header-loaded">Updated {formatDate(lastLoaded)}</span>
          )}
          <button className="btn btn-primary" onClick={fetchItems} disabled={loading}>
            {loading ? '⟳ Loading…' : '↺ Refresh'}
          </button>
        </div>
      </header>

      {/* Summary bar */}
      <div className="summary-bar">
        <SummaryCard label="Total" value={counts.total} />
        <SummaryCard label="Proposed" value={counts.proposed} accent="proposed" />
        <SummaryCard label="Approved" value={counts.approved} accent="approved" />
        <SummaryCard label="Open" value={counts.open} accent="open" />
        <SummaryCard label="In Progress" value={counts.in_progress} accent="inprogress" />
        <SummaryCard label="Blocked" value={counts.blocked} accent="blocked" />
        <SummaryCard label="Resolved" value={counts.resolved} accent="resolved" />
        <SummaryCard label="Risks" value={counts.risks} accent="risk" />
        <SummaryCard label="Decisions" value={counts.decisions} accent="decision" />
      </div>

      {/* Alerts */}
      {error && (
        <div className="alert alert-error">
          <strong>Error:</strong> {error}
        </div>
      )}
      {loading && <div className="loading-strip" />}

      {/* Tabs */}
      <div className="tab-bar">
        <button
          className={`tab-btn${activeTab === 'review' ? ' active' : ''}`}
          onClick={() => setActiveTab('review')}
        >
          Review Queue
          <span className="tab-badge">{reviewItems.length}</span>
        </button>
        <button
          className={`tab-btn${activeTab === 'work' ? ' active' : ''}`}
          onClick={() => setActiveTab('work')}
        >
          Work Board
          <span className="tab-badge">{boardItems.length}</span>
        </button>
        <button
          className={`tab-btn${activeTab === 'record' ? ' active' : ''}`}
          onClick={() => setActiveTab('record')}
        >
          Project Record
          <span className="tab-badge">{recordItems.length}</span>
        </button>
      </div>

      {/* Tab content */}
      <main className="tab-content">
        {/* Review Queue */}
        {activeTab === 'review' && (
          <div className="review-section">
            {!loading && reviewItems.length === 0 ? (
              <div className="empty-state">
                {items.length === 0
                  ? 'No items loaded yet.'
                  : 'No items pending review. All work items have been approved or rejected.'}
              </div>
            ) : (
              <div className="card-grid">
                {reviewItems.map(item => (
                  <ReviewCard
                    key={item.id}
                    item={item}
                    editingId={editingId}
                    onApprove={() => updateItem(item.id, { approvalStatus: 'approved' })}
                    onReject={() => updateItem(item.id, { approvalStatus: 'rejected' })}
                    onEdit={() => setEditingId(item.id)}
                    onEditSave={form => handleEditSave(item.id, form, true)}
                    onEditCancel={() => setEditingId(null)}
                  />
                ))}
              </div>
            )}
          </div>
        )}

        {/* Work Board */}
        {activeTab === 'work' && (
          <div className="work-board">
            {boardItems.length === 0 && !loading && (
              <div className="empty-state board-empty">
                No approved items yet. Approve items in the Review Queue to see them here.
              </div>
            )}
            {WORK_STATUSES.map(status => {
              const col = boardItems.filter(i => i.status === status);
              return (
                <div key={status} className="board-col">
                  <div className="col-header">
                    <StatusBadge status={status} />
                    <span className="col-count">{col.length}</span>
                  </div>
                  {col.length === 0 ? (
                    <div className="col-empty">—</div>
                  ) : (
                    col.map(item => (
                      <WorkCard
                        key={item.id}
                        item={item}
                        editingId={editingId}
                        onEdit={() => setEditingId(item.id)}
                        onEditSave={form => handleEditSave(item.id, form, true)}
                        onEditCancel={() => setEditingId(null)}
                        onStatusChange={v => updateItem(item.id, { status: v })}
                        onDelegate={() => updateItem(item.id, { delegationStatus: 'queued' })}
                        onMarkResolved={() => updateItem(item.id, { status: 'resolved' })}
                      />
                    ))
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* Project Record */}
        {activeTab === 'record' && (
          <ProjectRecord
            items={recordItems}
            editingId={editingId}
            onEdit={item => setEditingId(item.id)}
            onEditSave={(id, form) => handleEditSave(id, form, false)}
            onEditCancel={() => setEditingId(null)}
          />
        )}
      </main>
    </div>
  );
}

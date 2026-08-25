import { useState, useEffect, useCallback } from 'react';
import {
  buildBoardCounts,
  filterTasks,
  formatDate,
  fromDateInputValue,
  isReviewTask,
  normalizeTask,
  resolveAssigneeName,
  shortId,
  toDateInputValue,
} from './model.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const TYPE_LABELS = {
  development: 'Development',
  design: 'Design',
  research: 'Research',
  coordination: 'Coordination',
};

const ALL_TYPES = ['development', 'design', 'research', 'coordination'];

const STATUS_LABELS = {
  unapproved: 'Unapproved',
  backlog: 'Backlog',
  in_progress: 'In Progress',
  in_review: 'In Review',
  done: 'Done',
  archived: 'Archived',
};

// Review Queue owns `unapproved` — the board's columns are a traditional
// post-approval pipeline. `archived` is hidden behind a toggle rather than
// always shown, so the default board view stays focused on live work.
// `unapproved` is a valid move target too (not a column) — selecting it from
// a board card sends the task back to the Review Queue ("unapprove").
const KANBAN_STATUSES = ['backlog', 'in_progress', 'in_review', 'done'];
const KANBAN_MOVE_TARGETS = ['unapproved', 'backlog', 'in_progress', 'in_review', 'done', 'archived'];

// Delegation is board-local-only state (no schema/persistence — see
// storage/tasks-store.js's comment) available once a task's assignee is the
// special 'agent' entry (config/members.js). Default target is a per-task
// suggestion based on `type`, not a hard rule — always changeable before
// confirming.
const DELEGATION_TARGETS = ['dev-swarm', 'design-agent', 'research-agent'];
const DEFAULT_DELEGATION_TARGET_BY_TYPE = {
  development: 'dev-swarm',
  design: 'design-agent',
  research: 'research-agent',
  coordination: 'dev-swarm',
};

// ─── Badges ──────────────────────────────────────────────────────────────────

function TypeBadge({ type }) {
  return (
    <span className={`badge type-${type}`}>{TYPE_LABELS[type] ?? type}</span>
  );
}

function StatusBadge({ status }) {
  return (
    <span className={`badge status-${status}`}>
      {STATUS_LABELS[status] ?? status ?? '—'}
    </span>
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

function EditForm({ task, members = [], onSave, onCancel }) {
  const [title, setTitle] = useState(task.title ?? '');
  const [description, setDescription] = useState(task.description ?? '');
  const [type, setType] = useState(task.type ?? 'development');
  const [assigned, setAssigned] = useState(task.assigned ?? 'unknown');
  const [deadline, setDeadline] = useState(task.deadline ?? 'unknown');

  function handleSave() {
    onSave({ title, description, type, assigned, deadline });
  }

  // An assigned value that doesn't match any known member (e.g. a raw email
  // the model captured that isn't in the — currently dummy — member list)
  // gets one synthesized extra option, so editing never silently discards it.
  const isUnrecognizedAssignee =
    assigned && assigned !== 'unknown' && !members.some((member) => member.id === assigned);

  return (
    <div className="edit-form">
      <div className="edit-form-field">
        <label>Title</label>
        <input value={title} onChange={(e) => setTitle(e.target.value)} />
      </div>
      <div className="edit-form-field">
        <label>Description</label>
        <textarea
          rows={3}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>
      <div className="edit-form-row">
        <div className="edit-form-field">
          <label>Type</label>
          <select value={type} onChange={(e) => setType(e.target.value)}>
            {ALL_TYPES.map((t) => (
              <option key={t} value={t}>
                {TYPE_LABELS[t]}
              </option>
            ))}
          </select>
        </div>
        <div className="edit-form-field">
          <label>Assigned</label>
          <select value={assigned} onChange={(e) => setAssigned(e.target.value)}>
            <option value="unknown">Unassigned</option>
            {members.map((member) => (
              <option key={member.id} value={member.id}>
                {member.name}
              </option>
            ))}
            {isUnrecognizedAssignee && (
              <option value={assigned}>{assigned} (unrecognized)</option>
            )}
          </select>
        </div>
      </div>
      <div className="edit-form-field">
        <label>Deadline</label>
        <input
          type="date"
          value={toDateInputValue(deadline)}
          onChange={(e) => setDeadline(fromDateInputValue(e.target.value))}
        />
      </div>
      <div className="edit-form-actions">
        <span className="local-note">⚠ Local only — resets on refresh</span>
        <button className="btn btn-primary" onClick={handleSave}>
          Save
        </button>
        <button className="btn btn-ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

// ─── Task Meta (evidence / sub-tasks) ─────────────────────────────────────────

function TaskMeta({ task, members = [] }) {
  return (
    <div className="card-meta">
      <span className="meta-item">
        {task.assigned && task.assigned !== 'unknown'
          ? `👤 ${resolveAssigneeName(task.assigned, members)}`
          : 'Unassigned'}
      </span>
      {task.deadline && task.deadline !== 'unknown' && (
        <span className="meta-item">📅 {task.deadline}</span>
      )}
      {task.message_ids.length > 0 && (
        <span className="meta-item">
          📎 {task.message_ids.length} evidence
        </span>
      )}
      {task.child_tasks.length > 0 && (
        <span className="meta-item">
          🔗 {task.child_tasks.length} sub-task
          {task.child_tasks.length !== 1 ? 's' : ''}
        </span>
      )}
    </div>
  );
}

// ─── Review Card ─────────────────────────────────────────────────────────────

function ReviewCard({
  task,
  members,
  editingId,
  onApprove,
  onArchive,
  onEdit,
  onEditSave,
  onEditCancel,
}) {
  const isEditing = editingId === task.id;

  return (
    <div className={`card${isEditing ? ' card-editing' : ''}`}>
      <div className="card-header">
        <div className="card-badges">
          <TypeBadge type={task.type} />
        </div>
        {task.updatedAt && (
          <span className="card-time">{formatDate(task.updatedAt)}</span>
        )}
      </div>

      {isEditing ? (
        <EditForm task={task} members={members} onSave={onEditSave} onCancel={onEditCancel} />
      ) : (
        <>
          <h3 className="card-title">{task.title}</h3>
          {task.description && (
            <p className="card-description">{task.description}</p>
          )}
          <TaskMeta task={task} members={members} />
          <div className="card-actions">
            <button className="btn btn-approve" onClick={onApprove}>
              ✓ Approve
            </button>
            <button className="btn btn-reject" onClick={onArchive}>
              ✗ Archive
            </button>
            <button className="btn btn-ghost btn-sm" onClick={onEdit}>
              Edit
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// ─── Kanban Card ──────────────────────────────────────────────────────────────

function DelegateControl({ task, onDelegate }) {
  const [target, setTarget] = useState(
    task.delegation?.target ?? DEFAULT_DELEGATION_TARGET_BY_TYPE[task.type] ?? DELEGATION_TARGETS[0]
  );

  return (
    <div className="delegate-control">
      {task.delegation && (
        <span className="badge delegation-badge">→ {task.delegation.target}</span>
      )}
      <select value={target} onChange={(e) => setTarget(e.target.value)}>
        {DELEGATION_TARGETS.map((t) => (
          <option key={t} value={t}>
            {t}
          </option>
        ))}
      </select>
      <button className="btn btn-ghost btn-sm" onClick={() => onDelegate(target)}>
        🚀 {task.delegation ? 'Re-delegate' : 'Delegate'}
      </button>
    </div>
  );
}

function KanbanCard({
  task,
  members,
  editingId,
  onEdit,
  onEditSave,
  onEditCancel,
  onStatusChange,
  onDelegate,
}) {
  const isEditing = editingId === task.id;
  // Delegation is board-local-only (see storage/tasks-store.js's comment) —
  // only offered once a task is assigned to the special 'agent' entry
  // (config/members.js); delegating a human-owned or not-yet-approved task
  // doesn't make sense.
  const canDelegate = task.assigned === 'agent';

  return (
    <div className={`card${isEditing ? ' card-editing' : ''}`}>
      <div className="card-header">
        <div className="card-badges">
          <TypeBadge type={task.type} />
        </div>
        {task.updatedAt && (
          <span className="card-time">{formatDate(task.updatedAt)}</span>
        )}
      </div>

      {isEditing ? (
        <EditForm task={task} members={members} onSave={onEditSave} onCancel={onEditCancel} />
      ) : (
        <>
          <h3 className="card-title">{task.title}</h3>
          {task.description && (
            <p className="card-description">{task.description}</p>
          )}
          <TaskMeta task={task} members={members} />
          <div className="card-actions work-card-actions">
            <div className="card-actions-row">
              <select
                className="status-select"
                value={task.status}
                onChange={(e) => onStatusChange(e.target.value)}
              >
                {KANBAN_MOVE_TARGETS.map((s) => (
                  <option key={s} value={s}>
                    {STATUS_LABELS[s]}
                  </option>
                ))}
              </select>
              <button className="btn btn-ghost btn-sm" onClick={onEdit}>
                Edit
              </button>
            </div>
            {canDelegate && <DelegateControl task={task} onDelegate={onDelegate} />}
          </div>
        </>
      )}
    </div>
  );
}

// ─── App ──────────────────────────────────────────────────────────────────────

export default function App() {
  const spaceId =
    new URLSearchParams(window.location.search).get('spaceId') ?? '';

  const [tasks, setTasks] = useState([]);
  const [members, setMembers] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [lastLoaded, setLastLoaded] = useState(null);
  const [activeTab, setActiveTab] = useState('review');
  const [editingId, setEditingId] = useState(null);
  const [showArchived, setShowArchived] = useState(false);
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState('');

  const fetchTasks = useCallback(async () => {
    if (!spaceId) {
      setError('No spaceId in URL. Expected: ?spaceId=<id>');
      return;
    }
    setLoading(true);
    setError(null);
    setEditingId(null);
    try {
      const url = `/webex/collab/spaces/${encodeURIComponent(spaceId)}/tasks`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      const data = await res.json();
      const rawTasks = Array.isArray(data) ? data : (data.tasks ?? []);
      setTasks(rawTasks.map(normalizeTask));
      setLastLoaded(new Date());
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [spaceId]);

  // Dummy for now (config/members.js) — same-shaped fetch as fetchTasks, so
  // swapping in real space-membership data later is a backend-only change.
  const fetchMembers = useCallback(async () => {
    if (!spaceId) return;
    try {
      const url = `/webex/collab/spaces/${encodeURIComponent(spaceId)}/members`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      const data = await res.json();
      setMembers(Array.isArray(data.members) ? data.members : []);
    } catch {
      setMembers([]);
    }
  }, [spaceId]);

  useEffect(() => {
    fetchTasks();
    fetchMembers();
  }, [fetchTasks, fetchMembers]);

  function updateTask(id, patch) {
    setTasks((prev) =>
      prev.map((task) => (task.id === id ? { ...task, ...patch } : task))
    );
  }

  function handleEditSave(id, form) {
    updateTask(id, form);
    setEditingId(null);
  }

  // Derived slices
  const reviewTasks = filterTasks(tasks.filter(isReviewTask), { search, typeFilter, members });
  const kanbanStatuses = showArchived
    ? [...KANBAN_STATUSES, 'archived']
    : KANBAN_STATUSES;
  const kanbanTasks = tasks.filter((task) => kanbanStatuses.includes(task.status));

  const counts = buildBoardCounts(tasks);

  return (
    <div className="app">
      {/* Header */}
      <header className="app-header">
        <div className="header-left">
          <h1>Task Board</h1>
          {spaceId && (
            <span className="header-spaceid" title={spaceId}>
              Space: {shortId(spaceId)}…
            </span>
          )}
          <span className="local-disclaimer">
            Changes are local — refresh resets to backend state
          </span>
        </div>
        <div className="header-right">
          {lastLoaded && (
            <span className="header-loaded">
              Updated {formatDate(lastLoaded)}
            </span>
          )}
          <button
            className="btn btn-primary"
            onClick={fetchTasks}
            disabled={loading}
          >
            {loading ? '⟳ Loading…' : '↺ Refresh'}
          </button>
        </div>
      </header>

      {/* Summary bar */}
      <div className="summary-bar">
        <SummaryCard label="Total" value={counts.total} />
        <SummaryCard label="Unapproved" value={counts.unapproved} accent="unapproved" />
        <SummaryCard label="Backlog" value={counts.backlog} accent="backlog" />
        <SummaryCard
          label="In Progress"
          value={counts.inProgress}
          accent="in-progress"
        />
        <SummaryCard label="In Review" value={counts.inReview} accent="in-review" />
        <SummaryCard label="Done" value={counts.done} accent="done" />
        <SummaryCard
          label="Archived"
          value={counts.archived}
          accent="archived"
        />
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
          <span className="tab-badge">{counts.unapproved}</span>
        </button>
        <button
          className={`tab-btn${activeTab === 'board' ? ' active' : ''}`}
          onClick={() => setActiveTab('board')}
        >
          Board
          <span className="tab-badge">
            {counts.backlog + counts.inProgress + counts.inReview + counts.done}
          </span>
        </button>
      </div>

      {/* Tab content */}
      <main className="tab-content">
        {/* Review Queue */}
        {activeTab === 'review' && (
          <div className="review-section">
            <div className="record-controls">
              <input
                className="search-input"
                type="search"
                placeholder="Search title, description, assigned…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <select
                value={typeFilter}
                onChange={(e) => setTypeFilter(e.target.value)}
              >
                <option value="">All types</option>
                {ALL_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {TYPE_LABELS[t]}
                  </option>
                ))}
              </select>
              <span className="record-count">
                {reviewTasks.length} unapproved task
                {reviewTasks.length !== 1 ? 's' : ''}
              </span>
            </div>

            {!loading && reviewTasks.length === 0 ? (
              <div className="empty-state">
                {tasks.length === 0
                  ? 'No tasks loaded yet.'
                  : 'Nothing to review right now.'}
              </div>
            ) : (
              <div className="card-grid">
                {reviewTasks.map((task) => (
                  <ReviewCard
                    key={task.id}
                    task={task}
                    members={members}
                    editingId={editingId}
                    onApprove={() => updateTask(task.id, { status: 'backlog' })}
                    onArchive={() => updateTask(task.id, { status: 'archived' })}
                    onEdit={() => setEditingId(task.id)}
                    onEditSave={(form) => handleEditSave(task.id, form)}
                    onEditCancel={() => setEditingId(null)}
                  />
                ))}
              </div>
            )}
          </div>
        )}

        {/* Board */}
        {activeTab === 'board' && (
          <div className="board-section">
            <div className="record-controls">
              <label className="record-count">
                <input
                  type="checkbox"
                  checked={showArchived}
                  onChange={(e) => setShowArchived(e.target.checked)}
                />{' '}
                Show archived
              </label>
            </div>

            <div className="work-board">
              {kanbanTasks.length === 0 && !loading && (
                <div className="empty-state board-empty">
                  No approved tasks yet. Approve tasks in the Review Queue to
                  see them here.
                </div>
              )}
              {kanbanStatuses.map((status) => {
                const col = kanbanTasks.filter((t) => t.status === status);
                return (
                  <div key={status} className="board-col">
                    <div className="col-header">
                      <StatusBadge status={status} />
                      <span className="col-count">{col.length}</span>
                    </div>
                    {col.length === 0 ? (
                      <div className="col-empty">—</div>
                    ) : (
                      col.map((task) => (
                        <KanbanCard
                          key={task.id}
                          task={task}
                          members={members}
                          editingId={editingId}
                          onEdit={() => setEditingId(task.id)}
                          onEditSave={(form) => handleEditSave(task.id, form)}
                          onEditCancel={() => setEditingId(null)}
                          onStatusChange={(v) =>
                            updateTask(task.id, { status: v })
                          }
                          onDelegate={(target) =>
                            updateTask(task.id, {
                              delegation: { target, delegatedAt: new Date().toISOString() },
                            })
                          }
                        />
                      ))
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

import React, { useState, useEffect } from 'react';
import './App.css';

function newRepo(primary = false) {
  return { url: '', name: '', primary };
}

function newMember() {
  return { name: '', email: '', role: '' };
}

function GitHubIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z" />
    </svg>
  );
}

function App() {
  const params = new URLSearchParams(window.location.search);
  const spaceId = params.get('spaceId') || '';

  const [appName, setAppName] = useState('');
  const [project, setProject] = useState('');
  const [repos, setRepos] = useState([newRepo(true)]);
  const [members, setMembers] = useState([newMember()]);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const [done, setDone] = useState(false);

  useEffect(() => {
    fetch('/api/config')
      .then((r) => r.json())
      .then((data) => setAppName(data.appName || ''))
      .catch(() => {});
  }, []);

  if (!spaceId) {
    return (
      <div className="card">
        <div className="card-header">
          <h1>Project Setup</h1>
        </div>
        <div className="error-banner">
          Missing <code>spaceId</code> parameter. Use the link provided in
          Webex.
        </div>
      </div>
    );
  }

  if (done) {
    return (
      <div className="card">
        <div className="card-header">
          <h1>Project Setup</h1>
        </div>
        <div className="success-banner">
          <strong>Setup complete.</strong>
          You can return to Webex.
        </div>
      </div>
    );
  }

  function updateRepo(i, field, value) {
    setRepos((rs) =>
      rs.map((r, idx) => (idx === i ? { ...r, [field]: value } : r))
    );
  }

  function addRepo() {
    setRepos((rs) => [...rs, newRepo(false)]);
  }

  function removeRepo(i) {
    setRepos((rs) => rs.filter((_, idx) => idx !== i));
  }

  function updateMember(i, field, value) {
    setMembers((ms) =>
      ms.map((m, idx) => (idx === i ? { ...m, [field]: value } : m))
    );
  }

  function addMember() {
    setMembers((ms) => [...ms, newMember()]);
  }

  function removeMember(i) {
    setMembers((ms) => ms.filter((_, idx) => idx !== i));
  }

  const filledRepos = repos.filter((r) => r.url.trim());
  const filledMembers = members.filter((m) => m.email.trim() || m.name.trim());
  const primaryRepo = repos.find((r) => r.primary);
  const canSubmit =
    project.trim() &&
    primaryRepo &&
    primaryRepo.url.trim() &&
    filledMembers.length > 0;

  async function handleSubmit(e) {
    e.preventDefault();
    setSubmitError('');
    setSubmitting(true);

    const payload = {
      spaceId,
      project: project.trim(),
      repos: repos
        .filter((r) => r.url.trim())
        .map((r) => ({
          url: r.url.trim(),
          name: r.name.trim(),
          primary: r.primary,
        })),
      members: members
        .filter((m) => m.email.trim() || m.name.trim())
        .map((m) => ({
          name: m.name.trim(),
          email: m.email.trim(),
          role: m.role.trim(),
        })),
    };

    try {
      const res = await fetch('/api/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) {
        setSubmitError(data.error || 'Setup failed.');
      } else {
        setDone(true);
      }
    } catch {
      setSubmitError('Network error. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  const ghInstallUrl = appName
    ? `https://github.com/apps/${appName}/installations/new`
    : null;

  return (
    <div className="card">
      <div className="card-header">
        <h1>Project Setup</h1>
        <p>Configure this Webex space for agent collaboration.</p>
      </div>

      {submitError && <div className="error-banner">{submitError}</div>}

      <form onSubmit={handleSubmit}>
        <div className="section">
          <div className="section-title">Project</div>
          <div className="field">
            <label>Project name</label>
            <input
              type="text"
              placeholder="My Project"
              value={project}
              onChange={(e) => setProject(e.target.value)}
              required
            />
          </div>
        </div>

        <div className="section">
          <div className="section-title">Repositories</div>

          {repos.map((repo, i) => (
            <div key={i} className="repo-row">
              <div className={`field repo-url`}>
                {i === 0 && <label>Primary repo</label>}
                <input
                  type="text"
                  placeholder="owner/repo"
                  value={repo.url}
                  onChange={(e) => updateRepo(i, 'url', e.target.value)}
                />
              </div>
              <div className="field repo-name">
                {i === 0 && <label>Label (optional)</label>}
                <input
                  type="text"
                  placeholder="e.g. Frontend"
                  value={repo.name}
                  onChange={(e) => updateRepo(i, 'name', e.target.value)}
                />
              </div>
              {i === 0 ? (
                <span className="primary-badge">Primary</span>
              ) : (
                <button
                  type="button"
                  className="btn-remove"
                  onClick={() => removeRepo(i)}
                  title="Remove"
                >
                  ×
                </button>
              )}
            </div>
          ))}

          <button type="button" className="btn-add" onClick={addRepo}>
            + Add another repo
          </button>
        </div>

        <div className="section">
          <div className="section-title">Team Members</div>

          {members.map((member, i) => (
            <div key={i} className="member-row">
              <div className="field member-name">
                {i === 0 && <label>Name</label>}
                <input
                  type="text"
                  placeholder="Name"
                  value={member.name}
                  onChange={(e) => updateMember(i, 'name', e.target.value)}
                />
              </div>
              <div className="field member-email">
                {i === 0 && <label>Email</label>}
                <input
                  type="email"
                  placeholder="email@example.com"
                  value={member.email}
                  onChange={(e) => updateMember(i, 'email', e.target.value)}
                />
              </div>
              <div className="field member-role">
                {i === 0 && <label>Role</label>}
                <input
                  type="text"
                  placeholder="e.g. Backend"
                  value={member.role}
                  onChange={(e) => updateMember(i, 'role', e.target.value)}
                />
              </div>
              {members.length > 1 ? (
                <button
                  type="button"
                  className="btn-remove"
                  onClick={() => removeMember(i)}
                  title="Remove"
                >
                  ×
                </button>
              ) : (
                <span style={{ width: 24, flexShrink: 0 }} />
              )}
            </div>
          ))}

          <button type="button" className="btn-add" onClick={addMember}>
            + Add member
          </button>
        </div>

        <div className="section">
          <div className="section-title">GitHub Authorisation</div>

          {filledRepos.length > 0 && (
            <div className="gh-repos">
              Repos to authorise:
              {filledRepos.map((r, i) => (
                <span key={i}>
                  {r.url.trim()}
                  {r.name ? ` — ${r.name}` : ''}
                </span>
              ))}
            </div>
          )}

          {ghInstallUrl ? (
            <>
              <a
                href={ghInstallUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="btn-gh"
              >
                <GitHubIcon />
                Authorise on GitHub
              </a>
              <p className="gh-helper">
                Make sure the repos listed above are selected when authorising.
              </p>
            </>
          ) : (
            <p className="gh-helper">
              GitHub App name not configured — authorisation unavailable.
            </p>
          )}
        </div>

        <button
          type="submit"
          className="btn-submit"
          disabled={!canSubmit || submitting}
        >
          {submitting ? 'Setting up…' : 'Complete Setup'}
        </button>
      </form>
    </div>
  );
}

export default App;

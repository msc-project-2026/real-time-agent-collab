const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const WORKSPACE_DIR =
  process.env.OPENCLAW_WORKSPACE_DIR || '/home/node/.openclaw/workspace';
const GITHUB_APP_NAME = process.env.GITHUB_APP_NAME || '';

app.use(express.json());
app.use(express.static(path.join(__dirname, 'client')));

app.get('/health', (req, res) => {
  res.json({ ok: true });
});

app.get('/setup', (req, res) => {
  res.sendFile(path.join(__dirname, 'client', 'index.html'));
});

app.get('/api/config', (req, res) => {
  res.json({ appName: GITHUB_APP_NAME });
});

app.post('/api/setup', (req, res) => {
  const { spaceId, project, repos, members } = req.body;

  if (!spaceId || typeof spaceId !== 'string' || !spaceId.trim()) {
    return res.status(400).json({ error: 'spaceId is required' });
  }
  if (!project || typeof project !== 'string' || !project.trim()) {
    return res.status(400).json({ error: 'project name is required' });
  }
  if (!Array.isArray(repos) || repos.length === 0) {
    return res.status(400).json({ error: 'at least one repo is required' });
  }
  if (!repos.some((r) => r.primary)) {
    return res.status(400).json({ error: 'a primary repo is required' });
  }
  if (!Array.isArray(members) || members.length === 0) {
    return res.status(400).json({ error: 'at least one member is required' });
  }

  const collabDir = path.join(WORKSPACE_DIR, 'spaces', spaceId, '.collab');
  fs.mkdirSync(collabDir, { recursive: true });

  const config = {
    project: project.trim(),
    spaceId,
    createdAt: new Date().toISOString(),
    repos: repos.map((r) => ({
      url: r.url,
      name: r.name || '',
      primary: !!r.primary,
    })),
    members: members.map((m) => ({
      email: m.email,
      name: m.name,
      role: m.role || '',
    })),
  };

  fs.writeFileSync(
    path.join(collabDir, 'config.json'),
    JSON.stringify(config, null, 2)
  );

  const skeletons = {
    'context.md': '# Context\n\n_No context recorded yet._\n',
    'open-questions.md': '# Open Questions\n\n_No open questions yet._\n',
    'issues.md': '# Issues\n\n_No issues recorded yet._\n',
  };

  for (const [filename, content] of Object.entries(skeletons)) {
    const filepath = path.join(collabDir, filename);
    if (!fs.existsSync(filepath)) {
      fs.writeFileSync(filepath, content);
    }
  }

  res.json({ ok: true });
});

app.get('/api/spaces/:spaceId', (req, res) => {
  const { spaceId } = req.params;
  const configPath = path.join(
    WORKSPACE_DIR,
    'spaces',
    spaceId,
    '.collab',
    'config.json'
  );

  if (!fs.existsSync(configPath)) {
    return res.status(404).json({ error: 'space not configured' });
  }

  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    res.json(config);
  } catch {
    res.status(500).json({ error: 'failed to read config' });
  }
});

app.listen(PORT, () => {
  console.log(`setup-ui listening on port ${PORT}`);
});

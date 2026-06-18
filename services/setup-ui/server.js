import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { writeFile, readFile } from '../../lib/github.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const GITHUB_APP_NAME = process.env.GITHUB_APP_NAME || '';

app.use(express.json());
app.use(express.static(join(__dirname, 'client')));

app.get('/health', (req, res) => {
  res.json({ ok: true });
});

app.get('/setup', (req, res) => {
  res.sendFile(join(__dirname, 'client', 'index.html'));
});

app.get('/api/config', (req, res) => {
  res.json({ appName: GITHUB_APP_NAME });
});

app.post('/api/setup', async (req, res) => {
  const { spaceId, project, repos, members } = req.body;

  if (!spaceId || typeof spaceId !== 'string' || !spaceId.trim()) {
    return res.status(400).json({ ok: false, error: 'spaceId is required' });
  }
  if (!project || typeof project !== 'string' || !project.trim()) {
    return res.status(400).json({ ok: false, error: 'project name is required' });
  }
  if (!Array.isArray(repos) || repos.length === 0) {
    return res.status(400).json({ ok: false, error: 'at least one repo is required' });
  }
  if (!repos.some((r) => r.primary)) {
    return res.status(400).json({ ok: false, error: 'a primary repo is required' });
  }
  if (!Array.isArray(members) || members.length === 0) {
    return res.status(400).json({ ok: false, error: 'at least one member is required' });
  }

  const primaryRepo = repos.find((r) => r.primary);
  const [owner, repo] = primaryRepo.url.trim().split('/');
  if (!owner || !repo) {
    return res
      .status(400)
      .json({ ok: false, error: 'primary repo must be in owner/repo format' });
  }

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

  try {
    await writeFile(
      owner,
      repo,
      '.collab/config.json',
      JSON.stringify(config, null, 2),
      'chore: update .collab config'
    );

    const skeletons = {
      '.collab/context.md': '# Context\n\n_No context recorded yet._\n',
      '.collab/open-questions.md': '# Open Questions\n\n_No open questions yet._\n',
      '.collab/issues.md': '# Issues\n\n_No issues recorded yet._\n',
    };

    for (const [filePath, content] of Object.entries(skeletons)) {
      const existing = await readFile(owner, repo, filePath);
      if (existing === null) {
        await writeFile(owner, repo, filePath, content, `chore: initialise ${filePath}`);
      }
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('Setup error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`setup-ui listening on port ${PORT}`);
});

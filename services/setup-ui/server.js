import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import {
  writeFile as ghWriteFile,
  readFile as ghReadFile,
} from '@collab/github';
import { createHmac, timingSafeEqual } from 'crypto';
import {
  mkdir,
  readFile as fsReadFile,
  writeFile as fsWriteFile,
} from 'fs/promises';
import { lookup } from 'node:dns/promises';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const GITHUB_APP_NAME = process.env.GITHUB_APP_NAME || '';
const DATA_DIR = process.env.DATA_DIR || '/data';
const GITHUB_WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET || '';
const OPENCLAW_WEBHOOK_SECRET = process.env.OPENCLAW_WEBHOOK_SECRET || '';
const OPENCLAW_INTERNAL_URL =
  process.env.OPENCLAW_INTERNAL_URL ||
  'http://real-time-agent-collab.railway.internal:18789';

const BY_SPACE_DIR = join(DATA_DIR, 'by-space');
const BY_REPO_DIR = join(DATA_DIR, 'by-repo');

mkdir(BY_SPACE_DIR, { recursive: true }).catch((err) =>
  console.error('mkdir by-space:', err)
);
mkdir(BY_REPO_DIR, { recursive: true }).catch((err) =>
  console.error('mkdir by-repo:', err)
);

async function readSpaceConfig(spaceId) {
  try {
    const raw = await fsReadFile(join(BY_SPACE_DIR, `${spaceId}.json`), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function writeLocalCache(config, owner, repo) {
  await fsWriteFile(
    join(BY_SPACE_DIR, `${config.spaceId}.json`),
    JSON.stringify(config, null, 2),
    'utf8'
  );
  await fsWriteFile(
    join(BY_REPO_DIR, `${owner}-${repo}.json`),
    JSON.stringify({ spaceId: config.spaceId, owner, repo }, null, 2),
    'utf8'
  );
}

app.use(express.static(join(__dirname, 'dist')));

// Must be registered before express.json() to receive the raw Buffer body
app.post('/webhooks/github', express.raw({ type: '*/*' }), async (req, res) => {
  const sig = req.headers['x-hub-signature-256'];
  if (!sig || !GITHUB_WEBHOOK_SECRET) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  const expected =
    'sha256=' +
    createHmac('sha256', GITHUB_WEBHOOK_SECRET).update(req.body).digest('hex');

  let valid = false;
  try {
    valid = timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  } catch {
    valid = false;
  }

  if (!valid) {
    return res.status(401).json({ ok: false, error: 'invalid signature' });
  }

  const event = req.headers['x-github-event'];
  if (event !== 'push') {
    return res.json({ ok: true, ignored: true });
  }

  let payload;
  try {
    payload = JSON.parse(req.body.toString('utf8'));
  } catch {
    return res.status(400).json({ ok: false, error: 'invalid JSON' });
  }

  const commits = payload.commits || [];
  const collabChanged = commits.some((c) =>
    [...(c.added || []), ...(c.modified || []), ...(c.removed || [])].some(
      (f) => f.startsWith('.collab/')
    )
  );

  if (!collabChanged) {
    return res.json({ ok: true, ignored: true });
  }

  const fullName = payload.repository?.full_name || '';
  const [owner, repo] = fullName.split('/');
  if (!owner || !repo) {
    return res.json({ ok: true, ignored: true });
  }

  let repoConfig;
  try {
    const raw = await fsReadFile(
      join(BY_REPO_DIR, `${owner}-${repo}.json`),
      'utf8'
    );
    repoConfig = JSON.parse(raw);
  } catch {
    return res.json({ ok: true, ignored: true });
  }

  const { spaceId } = repoConfig;

  // Resolve hostname to IPv4 explicitly (OpenClaw only binds IPv4 it seems)
  const hostname = new URL(OPENCLAW_INTERNAL_URL).hostname;
  const { address } = await lookup(hostname, { family: 4 });
  const openclawUrl = OPENCLAW_INTERNAL_URL.replace(hostname, address);

  fetch(`${openclawUrl}/hooks/agent`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OPENCLAW_WEBHOOK_SECRET}`,
    },
    body: JSON.stringify({
      message: `[SYSTEM] .collab/ update detected in ${owner}/${repo}. Acknowledge this in the space with a brief message.`,
      sessionKey: `webex:${spaceId}`,
      name: 'collab-sync',
    }),
  }).catch((err) => console.error('OpenClaw forward error:', err));

  return res.json({ ok: true });
});

app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ ok: true });
});

app.get('/setup', (req, res) => {
  res.sendFile(join(__dirname, 'dist', 'index.html'));
});

app.get('/api/config', (req, res) => {
  res.json({ appName: GITHUB_APP_NAME });
});

app.get('/api/spaces/:spaceId', async (req, res) => {
  const config = await readSpaceConfig(req.params.spaceId);
  if (!config) {
    return res.status(404).json({ ok: false, error: 'not found' });
  }
  res.json(config);
});

app.post('/api/setup', async (req, res) => {
  const { spaceId, project, repos, members } = req.body;

  if (!spaceId || typeof spaceId !== 'string' || !spaceId.trim()) {
    return res.status(400).json({ ok: false, error: 'spaceId is required' });
  }
  if (!project || typeof project !== 'string' || !project.trim()) {
    return res
      .status(400)
      .json({ ok: false, error: 'project name is required' });
  }
  if (!Array.isArray(repos) || repos.length === 0) {
    return res
      .status(400)
      .json({ ok: false, error: 'at least one repo is required' });
  }
  if (!repos.some((r) => r.primary)) {
    return res
      .status(400)
      .json({ ok: false, error: 'a primary repo is required' });
  }
  if (!Array.isArray(members) || members.length === 0) {
    return res
      .status(400)
      .json({ ok: false, error: 'at least one member is required' });
  }

  const primaryRepo = repos.find((r) => r.primary);
  const [owner, repo] = primaryRepo.url.trim().split('/');
  if (!owner || !repo) {
    return res
      .status(400)
      .json({ ok: false, error: 'primary repo must be in owner/repo format' });
  }

  const existing = await readSpaceConfig(spaceId);
  const now = new Date().toISOString();

  const config = {
    project: project.trim(),
    spaceId,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    version: (existing?.version ?? 0) + 1,
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
    await ghWriteFile(
      owner,
      repo,
      '.collab/config.json',
      JSON.stringify(config, null, 2),
      'chore: update .collab config'
    );

    const skeletons = {
      '.collab/context.md': '# Context\n\n_No context recorded yet._\n',
      '.collab/open-questions.md':
        '# Open Questions\n\n_No open questions yet._\n',
      '.collab/issues.md': '# Issues\n\n_No issues recorded yet._\n',
    };

    for (const [filePath, content] of Object.entries(skeletons)) {
      const existingFile = await ghReadFile(owner, repo, filePath);
      if (existingFile === null) {
        await ghWriteFile(
          owner,
          repo,
          filePath,
          content,
          `chore: initialise ${filePath}`
        );
      }
    }
  } catch (err) {
    console.error('Setup error (GitHub):', err);
    return res.status(500).json({ ok: false, error: err.message });
  }

  try {
    await writeLocalCache(config, owner, repo);
  } catch (err) {
    console.error('Setup error (local cache):', err);
    return res
      .status(500)
      .json({ ok: false, error: 'Failed to write local config cache' });
  }

  res.json({ ok: true, version: config.version });
});

app.listen(PORT, () => {
  console.log(`setup-ui listening on port ${PORT}`);
});

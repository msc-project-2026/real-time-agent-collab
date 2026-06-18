const { createHmac, timingSafeEqual } = require('node:crypto');
const { mkdir, writeFile: fsWriteFile } = require('node:fs/promises');
const { join } = require('node:path');
const { readFile, listFiles } = require('@collab/github');

const WORKSPACE_DIR =
  process.env.OPENCLAW_WORKSPACE_DIR ?? '/home/node/.openclaw/workspace';

function verifySignature(secret, rawBody, signatureHeader) {
  if (!signatureHeader?.startsWith('sha256=')) return false;
  const expected = Buffer.from(signatureHeader.slice(7), 'hex');
  const actual = createHmac('sha256', secret).update(rawBody).digest();
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

async function handleWebhook(req, res) {
  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.setHeader('Allow', 'POST');
    res.end('Method Not Allowed');
    return true;
  }

  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!secret) {
    res.statusCode = 500;
    res.end('GITHUB_WEBHOOK_SECRET not set');
    return true;
  }

  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const rawBody = Buffer.concat(chunks);

  if (!verifySignature(secret, rawBody, req.headers['x-hub-signature-256'])) {
    res.statusCode = 401;
    res.end('Unauthorized');
    return true;
  }

  if (req.headers['x-github-event'] !== 'push') {
    res.statusCode = 200;
    res.end('Ignored');
    return true;
  }

  let payload;
  try {
    payload = JSON.parse(rawBody.toString('utf-8'));
  } catch {
    res.statusCode = 400;
    res.end('Bad Request');
    return true;
  }

  const relevant = payload.commits?.some((commit) =>
    [
      ...(commit.added || []),
      ...(commit.modified || []),
      ...(commit.removed || []),
    ].some((file) => file.startsWith('.collab/'))
  );

  if (!relevant) {
    res.statusCode = 200;
    res.end('No .collab/ changes');
    return true;
  }

  const [owner, repo] = payload.repository.full_name.split('/');

  const configContent = await readFile(owner, repo, '.collab/config.json');
  if (!configContent) {
    res.statusCode = 200;
    res.end('No .collab/config.json');
    return true;
  }

  const { spaceId } = JSON.parse(configContent);
  const spaceCollabDir = join(WORKSPACE_DIR, 'spaces', spaceId, '.collab');
  await mkdir(spaceCollabDir, { recursive: true });

  const files = await listFiles(owner, repo, '.collab');
  await Promise.all(
    files.map(async (filename) => {
      const content = await readFile(owner, repo, `.collab/${filename}`);
      if (content === null) return;
      await fsWriteFile(join(spaceCollabDir, filename), content, 'utf-8');
    })
  );

  res.statusCode = 200;
  res.end('Synced');
  return true;
}

function register(api) {
  api.registerHttpRoute({
    path: '/webhooks/github',
    auth: 'plugin',
    match: 'prefix',
    nodeCapability: { surface: 'github-webhook' },
    handler: handleWebhook,
  });
}

module.exports = register;
module.exports.default = register;
module.exports.id = 'github';

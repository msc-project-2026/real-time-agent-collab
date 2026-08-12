// Self-contained persistence for generated meeting minutes. Runtime state is
// local to the OpenClaw workspace, but project memory belongs in the primary
// GitHub repository mapped to the Webex space.
'use strict';

const { createSign } = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const GITHUB_API = 'https://api.github.com';
const MINUTES_PATH = '.collab/meeting minutes.md';
const DEFAULT_WORKSPACE_ROOT = '/home/node/.openclaw/workspace';

function getWorkspaceRoot(explicitRoot, env = process.env) {
  return explicitRoot ?? env.OPENCLAW_WORKSPACE_DIR ?? DEFAULT_WORKSPACE_ROOT;
}

function safeSegment(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]/g, '_');
}

function parseRepoRef(value) {
  let ref = String(value ?? '').trim();
  if (!ref) return null;
  ref = ref.replace(/^git@github\.com:/i, '').replace(/^https?:\/\/github\.com\//i, '');
  ref = ref.replace(/^github\.com\//i, '').replace(/\.git$/i, '').replace(/^\/+|\/+$/g, '');
  const [owner, repo, ...rest] = ref.split('/');
  if (!owner || !repo || rest.length) return null;
  return { owner, repo };
}

async function readJsonIfPresent(file) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
}

async function resolveProjectRepo(roomId, { workspaceRoot, env = process.env } = {}) {
  const root = getWorkspaceRoot(workspaceRoot, env);
  const segment = safeSegment(roomId);
  const candidates = [
    path.join(root, 'spaces', segment, 'config.json'),
    path.join(root, '.collab', 'spaces', segment, 'config.json'),
  ];
  for (const file of candidates) {
    const config = await readJsonIfPresent(file);
    if (!config) continue;
    const repoEntry = config.repos?.find((repo) => repo?.primary) ?? config.repos?.[0];
    const repo = parseRepoRef(repoEntry?.url ?? repoEntry?.repo ?? repoEntry);
    if (repo) return repo;
  }

  const owner = String(env.COLLAB_GITHUB_OWNER ?? '').trim();
  const repo = String(env.COLLAB_GITHUB_REPO ?? '').trim();
  if (owner && repo) return { owner, repo };

  throw new Error(
    `No primary project repository is configured for Webex room ${roomId}; ` +
      `expected ${candidates[0]} or COLLAB_GITHUB_OWNER/COLLAB_GITHUB_REPO`
  );
}

function readPrivateKey(env) {
  const file = String(env.GITHUB_APP_PRIVATE_KEY_FILE ?? '').trim();
  if (file) return fs.readFileSync(file, 'utf8');
  return String(env.GITHUB_APP_PRIVATE_KEY ?? '').replace(/\\n/g, '\n');
}

function createGithubAppJwt(env, nowMs = Date.now()) {
  const appId = String(env.GITHUB_APP_ID ?? '').trim();
  const privateKey = readPrivateKey(env);
  if (!appId || !privateKey) {
    throw new Error(
      'Meeting-minutes persistence requires WEBEX_MEETING_MINUTES_GITHUB_TOKEN ' +
        'or GITHUB_APP_ID plus GITHUB_APP_PRIVATE_KEY_FILE/GITHUB_APP_PRIVATE_KEY'
    );
  }
  const now = Math.floor(nowMs / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ iat: now - 60, exp: now + 600, iss: appId })).toString('base64url');
  const input = `${header}.${payload}`;
  const sign = createSign('RSA-SHA256');
  sign.update(input);
  return `${input}.${sign.sign(privateKey, 'base64url')}`;
}

function encodeGithubPath(filePath) {
  return String(filePath).split('/').map(encodeURIComponent).join('/');
}

function meetingMarker(meetingId) {
  return `<!-- webex-meeting-id:${encodeURIComponent(String(meetingId))} -->`;
}

function cleanInline(value, fallback) {
  const text = String(value ?? '').replace(/[\r\n]+/g, ' ').trim();
  return text || fallback;
}

function formatMeetingSection({ meetingId, transcriptId, meeting = {}, minutes }) {
  const title = cleanInline(meeting.title ?? meeting.topic, 'Webex meeting');
  const start = cleanInline(meeting.start ?? meeting.startTime ?? meeting.actualStart, 'Unknown');
  const end = cleanInline(meeting.end ?? meeting.endTime ?? meeting.actualEnd, 'Unknown');
  const safeMeetingId = cleanInline(meetingId, 'unknown').replace(/`/g, '\\`');
  const safeTranscriptId = cleanInline(transcriptId, 'unknown').replace(/`/g, '\\`');
  return [
    meetingMarker(meetingId),
    `## ${title}`,
    '',
    `- **Started:** ${start}`,
    `- **Ended:** ${end}`,
    `- **Webex meeting ID:** \`${safeMeetingId}\``,
    `- **Transcript ID:** \`${safeTranscriptId}\``,
    '',
    String(minutes ?? '').trim(),
  ].join('\n').trim();
}

function createMinutesStore({
  workspaceRoot = null,
  env = process.env,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  tokenProvider = null,
  log = null,
} = {}) {
  const installationTokens = new Map(); // owner/repo -> { token, expiresAt }
  const writeQueues = new Map();

  async function githubRequest(url, options = {}) {
    return fetchImpl(url, {
      ...options,
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'openclaw-webex-meeting-join',
        ...options.headers,
      },
    });
  }

  async function getToken(owner, repo) {
    if (tokenProvider) return tokenProvider(owner, repo);
    const direct = String(env.WEBEX_MEETING_MINUTES_GITHUB_TOKEN ?? '').trim();
    if (direct) return direct;

    const key = `${owner}/${repo}`;
    const cached = installationTokens.get(key);
    if (cached && cached.expiresAt - now() > 5 * 60 * 1000) return cached.token;

    const jwt = createGithubAppJwt(env, now());
    const installation = await githubRequest(`${GITHUB_API}/repos/${owner}/${repo}/installation`, {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    if (!installation.ok) {
      throw new Error(`Failed to find GitHub App installation for ${key}: HTTP ${installation.status}`);
    }
    const installationId = (await installation.json()).id;
    const tokenResponse = await githubRequest(
      `${GITHUB_API}/app/installations/${installationId}/access_tokens`,
      { method: 'POST', headers: { Authorization: `Bearer ${jwt}` } }
    );
    if (!tokenResponse.ok) {
      throw new Error(`Failed to create GitHub installation token for ${key}: HTTP ${tokenResponse.status}`);
    }
    const data = await tokenResponse.json();
    installationTokens.set(key, { token: data.token, expiresAt: new Date(data.expires_at).getTime() });
    return data.token;
  }

  async function readMinutes(owner, repo, token) {
    const response = await githubRequest(
      `${GITHUB_API}/repos/${owner}/${repo}/contents/${encodeGithubPath(MINUTES_PATH)}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (response.status === 404) return { content: '', sha: null };
    if (!response.ok) throw new Error(`Failed to read ${MINUTES_PATH}: HTTP ${response.status}`);
    const data = await response.json();
    return { content: Buffer.from(data.content, 'base64').toString('utf8'), sha: data.sha };
  }

  async function putMinutes(owner, repo, token, content, sha) {
    return githubRequest(
      `${GITHUB_API}/repos/${owner}/${repo}/contents/${encodeGithubPath(MINUTES_PATH)}`,
      {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: 'collab: add Webex meeting minutes',
          content: Buffer.from(content, 'utf8').toString('base64'),
          ...(sha ? { sha } : {}),
        }),
      }
    );
  }

  function enqueue(key, job) {
    const previous = writeQueues.get(key) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(job).finally(() => {
      if (writeQueues.get(key) === next) writeQueues.delete(key);
    });
    writeQueues.set(key, next);
    return next;
  }

  async function appendMeetingMinutes({ roomId, meetingId, transcriptId, meeting, minutes }) {
    if (!roomId) throw new Error('roomId is required to resolve the project repository');
    if (!meetingId) throw new Error('meetingId is required for idempotent meeting-minutes storage');
    const { owner, repo } = await resolveProjectRepo(roomId, { workspaceRoot, env });
    const key = `${owner}/${repo}:${MINUTES_PATH}`;
    return enqueue(key, async () => {
      const token = await getToken(owner, repo);
      const marker = meetingMarker(meetingId);
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const existing = await readMinutes(owner, repo, token);
        if (existing.content.includes(marker)) {
          log?.info?.(`[webex-meeting-join] minutes already stored for meeting=${meetingId}`);
          return { written: false, duplicate: true, owner, repo, path: MINUTES_PATH };
        }
        const heading = existing.content.trim() ? existing.content.trimEnd() : '# Meeting Minutes';
        const section = formatMeetingSection({ meetingId, transcriptId, meeting, minutes });
        const updated = `${heading}\n\n${section}\n`;
        const response = await putMinutes(owner, repo, token, updated, existing.sha);
        if (response.ok) return { written: true, owner, repo, path: MINUTES_PATH };
        if (![409, 422].includes(response.status) || attempt === 3) {
          const detail = await response.text().catch(() => '');
          throw new Error(`Failed to write ${MINUTES_PATH}: HTTP ${response.status}: ${detail}`);
        }
        await new Promise((resolve) => setTimeout(resolve, attempt * 100));
      }
      throw new Error(`Failed to write ${MINUTES_PATH}`);
    });
  }

  return { appendMeetingMinutes, resolveProjectRepo: (roomId) => resolveProjectRepo(roomId, { workspaceRoot, env }) };
}

module.exports = {
  MINUTES_PATH,
  createMinutesStore,
  parseRepoRef,
  resolveProjectRepo,
  meetingMarker,
  formatMeetingSection,
};

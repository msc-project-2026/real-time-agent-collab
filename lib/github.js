import { createSign } from 'node:crypto';

const GITHUB_API = 'https://api.github.com';

// key = `${owner}/${repo}`, value = { token, expiresAt (ms) }
const tokenCache = new Map();

function createJWT() {
  const appId = process.env.GITHUB_APP_ID;
  const privateKey = process.env.GITHUB_APP_PRIVATE_KEY;

  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(
    JSON.stringify({ alg: 'RS256', typ: 'JWT' })
  ).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({
      iat: now - 60, // 60s in the past to guard against clock skew
      exp: now + 600, // 10 minutes
      iss: appId,
    })
  ).toString('base64url');

  const signingInput = `${header}.${payload}`;
  const sign = createSign('RSA-SHA256');
  sign.update(signingInput);
  const signature = sign.sign(privateKey, 'base64url');

  return `${signingInput}.${signature}`;
}

async function apiRequest(url, options = {}) {
  return fetch(url, {
    ...options,
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...options.headers,
    },
  });
}

async function getInstallationId(owner, repo) {
  const jwt = createJWT();
  const res = await apiRequest(
    `${GITHUB_API}/repos/${owner}/${repo}/installation`,
    {
      headers: { Authorization: `Bearer ${jwt}` },
    }
  );
  if (!res.ok) {
    throw new Error(
      `Failed to look up installation for ${owner}/${repo}: HTTP ${res.status}`
    );
  }
  const data = await res.json();
  return data.id;
}

export async function getInstallationToken(owner, repo) {
  const key = `${owner}/${repo}`;
  const cached = tokenCache.get(key);

  // Reuse cached token if it has more than 5 minutes left
  if (cached && cached.expiresAt - Date.now() > 5 * 60 * 1000) {
    return cached.token;
  }

  const jwt = createJWT();
  const installationId = await getInstallationId(owner, repo);

  const res = await apiRequest(
    `${GITHUB_API}/app/installations/${installationId}/access_tokens`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${jwt}` },
    }
  );
  if (!res.ok) {
    throw new Error(
      `Failed to get installation access token: HTTP ${res.status}`
    );
  }

  const data = await res.json();
  tokenCache.set(key, {
    token: data.token,
    expiresAt: new Date(data.expires_at).getTime(),
  });
  return data.token;
}

export async function readFile(owner, repo, path) {
  const token = await getInstallationToken(owner, repo);
  const res = await apiRequest(
    `${GITHUB_API}/repos/${owner}/${repo}/contents/${path}`,
    {
      headers: { Authorization: `Bearer ${token}` },
    }
  );

  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Failed to read ${path}: HTTP ${res.status}`);

  const data = await res.json();
  return Buffer.from(data.content, 'base64').toString('utf-8');
}

export async function writeFile(owner, repo, path, content, commitMessage) {
  const token = await getInstallationToken(owner, repo);

  // Fetch existing SHA so updates work (create doesn't need it)
  let sha;
  const existing = await apiRequest(
    `${GITHUB_API}/repos/${owner}/${repo}/contents/${path}`,
    {
      headers: { Authorization: `Bearer ${token}` },
    }
  );
  if (existing.ok) {
    sha = (await existing.json()).sha;
  }

  const res = await apiRequest(
    `${GITHUB_API}/repos/${owner}/${repo}/contents/${path}`,
    {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        message: commitMessage,
        content: Buffer.from(content, 'utf-8').toString('base64'),
        ...(sha && { sha }),
      }),
    }
  );

  if (!res.ok) throw new Error(`Failed to write ${path}: HTTP ${res.status}`);
}

export async function listFiles(owner, repo, path) {
  const token = await getInstallationToken(owner, repo);
  const res = await apiRequest(
    `${GITHUB_API}/repos/${owner}/${repo}/contents/${path}`,
    {
      headers: { Authorization: `Bearer ${token}` },
    }
  );

  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`Failed to list ${path}: HTTP ${res.status}`);

  const data = await res.json();
  if (!Array.isArray(data)) return [];
  return data.map((item) => item.name);
}

export async function getCommitsSince(owner, repo, since) {
  const token = await getInstallationToken(owner, repo);
  const url = new URL(`${GITHUB_API}/repos/${owner}/${repo}/commits`);
  url.searchParams.set('since', since);

  const res = await apiRequest(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Failed to get commits: HTTP ${res.status}`);
  return res.json();
}

export async function getCommitDiff(owner, repo, sha) {
  const token = await getInstallationToken(owner, repo);
  const res = await fetch(
    `${GITHUB_API}/repos/${owner}/${repo}/commits/${sha}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github.diff',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    }
  );
  if (!res.ok)
    throw new Error(`Failed to get diff for ${sha}: HTTP ${res.status}`);
  return res.text();
}

export async function createPullRequest(
  owner,
  repo,
  { title, body, head, base }
) {
  const token = await getInstallationToken(owner, repo);
  const res = await apiRequest(`${GITHUB_API}/repos/${owner}/${repo}/pulls`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ title, body, head, base }),
  });
  if (!res.ok)
    throw new Error(`Failed to create pull request: HTTP ${res.status}`);
  const data = await res.json();
  return data.html_url;
}

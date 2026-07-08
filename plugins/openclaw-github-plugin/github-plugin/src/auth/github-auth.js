/**
 * github-plugin.js
 *
 * GitHub App authentication module.
 * Handles 
 * - JWT generation, 
 * - GitHub App installation details retrieval,
 * - Installation Access Token exchange, 
 * - token caching.
 *
 * Dependencies (add to package.json):
 *   "jsonwebtoken": "^9.0.0"
 *   "@octokit/request": "^9.0.0"
 */

import { readFileSync } from "fs";
import jwt from "jsonwebtoken";
import { request } from "@octokit/request";

// ---------------------------------------------------------------------------
// Token cache
// One cached token per installation ID.
// Shape: Map<installationId, { token: string, expiresAt: number }>
// ---------------------------------------------------------------------------

const tokenCache = new Map();

/**
 * How many milliseconds before the real expiry we consider the token stale.
 * GitHub tokens last 1 hour; we refresh 3 minutes early to avoid edge cases.
 */
const EXPIRY_BUFFER_MS = 3 * 60 * 1000;

// ---------------------------------------------------------------------------
// JWT generation  (App-level identity, valid for 10 minutes)
// ---------------------------------------------------------------------------

/**
 * Creates a signed JWT that proves "I am this GitHub App".
 *
 * @param {string} appId       - GitHub App ID (from App settings page)
 * @param {string} privateKey  - PEM-encoded private key (the .pem file content)
 * @returns {string}           - Signed JWT string
 */
export function createJwt(appId, privateKey) {
  const now = Math.floor(Date.now() / 1000);

  const payload = {
    iat: now - 60,   // issued-at: 60s in the past to account for clock skew
    exp: now + 540,  // expires: 9 minutes from now (max is 10, stay safe)
    iss: appId,      // issuer = the App ID
  };

  return jwt.sign(payload, privateKey, { algorithm: "RS256" });
}

// ---------------------------------------------------------------------------
// Installation Access Token exchange  (repo-level credentials, valid 1 hour)
// ---------------------------------------------------------------------------

/**
 * Calls the GitHub API to exchange a JWT for an Installation Access Token.
 * This token is what actually authorises repo/issue/PR operations.
 *
 * @param {string} jwt            - A valid App-level JWT
 * @param {string} installationId - Installation ID
 * @returns {{ token: string, expiresAt: number }}
 */
async function fetchInstallationToken(appJwt, installationId) {
  const response = await request(
    "POST /app/installations/{installation_id}/access_tokens",
    {
      installation_id: installationId,
      headers: {
        authorization: `Bearer ${appJwt}`,
        "x-github-api-version": "2022-11-28",
      },
    }
  );

  const token = response.data.token;

  // GitHub returns ISO 8601, e.g. "2025-01-01T01:00:00Z"
  const expiresAt = new Date(response.data.expires_at).getTime();

  return { token, expiresAt };
}

/**
 * Fetches the GitHub App installation details.
 *
 * @param {string} appJwt         - A valid App-level JWT
 * @param {string} installationId - Installation ID
 * @returns {Promise<any>}        - The installation details object
 */
export async function getInstallationDetails(appJwt, installationId) {
  const response = await request(
    "GET /app/installations/{installation_id}",
    {
      installation_id: installationId,
      headers: {
        authorization: `Bearer ${appJwt}`,
        "x-github-api-version": "2022-11-28",
      },
    }
  );
  return response.data;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------


/**
 * Resolves the private key from config, supporting both inline and file-based keys.
 *
 * @param {object} config
 * @param {string} [config.privateKey]     - PEM private key string (optional)
 * @param {string} [config.privateKeyFile] - Path to PEM file (optional)
 * @returns {string}                        - PEM private key content
 */
export function resolvePrivateKey(config) {
  if (config.privateKey) return config.privateKey;
  if (config.privateKeyFile) return readFileSync(config.privateKeyFile, "utf8");
  throw new Error("Missing privateKey or privateKeyFile in config");
}


/**
 * Returns a valid Installation Access Token, using the cache when possible.
 *
 * This is the only function your tool execute() handlers need to call.
 *
 * @param {object} config
 * @param {string} config.appId          - GitHub App ID
 * @param {string} [config.privateKey]     - PEM private key string (optional)
 * @param {string} [config.privateKeyFile] - Path to PEM file (optional)
 * @param {string} config.installationId - Installation ID
 * @returns {Promise<string>}            - A valid bearer token
 */
export async function getInstallationToken(config) {
  const { appId, installationId } = config;
  const privateKey = resolvePrivateKey(config);

  const cached = tokenCache.get(installationId);
  const now = Date.now();

  // Return cached token if it has enough life left
  if (cached && cached.expiresAt - now > EXPIRY_BUFFER_MS) {
    return cached.token;
  }

  // Cache miss or token expiring soon — go get a fresh one
  const appJwt = createJwt(appId, privateKey);
  const { token, expiresAt } = await fetchInstallationToken(appJwt, installationId);

  tokenCache.set(installationId, { token, expiresAt });

  return token;
}

/**
 * Calls a GitHub REST API endpoint using the installation access token.
 *
 * Tool handlers should use this for repo, issue, pull request, and workflow
 * operations so token exchange and standard headers stay in one place.
 *
 * @param {object} config
 * @param {string} method - HTTP method, e.g. "GET", "POST", "PATCH", "PUT", "DELETE"
 * @param {string} route  - GitHub REST route, e.g. "/repos/{owner}/{repo}/contents/{path}"
 * @param {object} [params] - Octokit request params, including path/query/body fields
 * @returns {Promise<any>} - GitHub response data
 */
export async function githubRequest(config, method, route, params = {}) {
  const token = await getInstallationToken(config);
  const normalizedMethod = method.toUpperCase();
  const normalizedRoute = route.startsWith("/") ? route : `/${route}`;
  const headers = {
    ...(params.headers ?? {}),
    authorization: `Bearer ${token}`,
    "x-github-api-version": "2022-11-28",
  };

  const response = await request(`${normalizedMethod} ${normalizedRoute}`, {
    ...params,
    headers,
  });

  return response.data;
}

/**
 * Clears the token cache for a specific installation, or all installations.
 * Useful in tests or when you know a token has been revoked.
 *
 * @param {string} [installationId] - Omit to clear everything
 */
export function clearTokenCache(installationId) {
  if (installationId) {
    tokenCache.delete(installationId);
  } else {
    tokenCache.clear();
  }
}
# Real-Time Agent Collaboration

An AI agent collaboration system that connects a Cisco Webex bot to an [OpenClaw](https://github.com/openclaw/openclaw) gateway, backed by a Cisco LLM proxy. A companion Setup UI lets teams onboard new projects by writing configuration directly to their GitHub repos via a GitHub App.

---

## Table of contents

- [Architecture](#architecture)
- [Repository structure](#repository-structure)
- [Services](#services)
  - [OpenClaw gateway](#openclaw-gateway)
  - [Webex channel plugin](#webex-channel-plugin)
  - [Setup UI](#setup-ui)
  - [Caddy reverse proxy](#caddy-reverse-proxy)
- [Shared library — `@collab/github`](#shared-library--collabgithub)
- [Gateway configuration](#gateway-configuration)
- [Environment variables](#environment-variables)
- [Deployment](#deployment)
  - [Prerequisites](#prerequisites)
  - [Server setup](#server-setup)
  - [First launch](#first-launch)
  - [Auto-deploy on push](#auto-deploy-on-push)
- [Operations cheatsheet](#operations-cheatsheet)
- [Troubleshooting](#troubleshooting)

---

## Architecture

```
Internet
  │
  ▼
Caddy :443 / :80   (automatic HTTPS via Let's Encrypt)
  │
  ├── /setup*, /api/*  ──►  setup-ui :3000   (Express + React)
  │                                │
  │                                └── GitHub API (writes .collab/ files)
  │
  └── everything else ──►  openclaw :18789   (OpenClaw gateway)
                                    │
                                    └── plugins/webex  ──►  Webex API
                                                        ◄──  Webex webhook POSTs
                                                        │
                                                        └──►  Cisco LLM proxy
```

Three containers run on a `collab` Docker bridge network. Caddy holds a static IP (`172.28.0.10`) and is the only container with public ports. All inter-service traffic stays on the internal network.

---

## Repository structure

```
real-time-agent-collab/
├── config/
│   └── openclaw.json          # Versioned gateway config (source of truth)
├── lib/
│   ├── package.json           # Declares the @collab/github workspace package
│   └── github.js              # GitHub App helper: JWT auth, file read/write, commits, PRs
├── plugins/
│   └── webex/
│       ├── package.json       # Plugin manifest (@openclaw/webex)
│       ├── openclaw.plugin.json  # Plugin metadata and config schema
│       ├── index.js           # Plugin entry point — registers channel + HTTP route
│       ├── channel.js         # OpenClaw channel contract implementation
│       ├── inbound.js         # Inbound message filtering and agent pipeline dispatch
│       ├── webhook.js         # HTTP route handler, HMAC-SHA1 verification, target registry
│       ├── token.js           # OAuth token state, refresh interval, webhook registration
│       ├── send.js            # Outbound message body builder
│       └── api.js             # Webex REST API base URL and authenticated fetch helper
├── services/
│   └── setup-ui/
│       ├── Dockerfile         # Build context is repo root (needs lib/ workspace)
│       ├── package.json       # setup-ui package; depends on @collab/github and express
│       ├── vite.config.js     # Vite config: root=client, output=dist/
│       ├── server.js          # Express server — health, setup form, GitHub write API
│       └── client/
│           ├── index.html     # Vite entry HTML
│           ├── main.jsx       # React root mount
│           ├── App.jsx        # Setup form (project, repos, members, GitHub auth)
│           └── App.css        # Styles
├── scripts/
│   └── deploy.sh              # Rebuild and restart the stack (used by CI and manually)
├── .env.example               # Copy to .env and fill in — never commit .env
├── .dockerignore
├── docker-compose.yml         # VPS stack: caddy + openclaw + setup-ui
├── Caddyfile                  # Reverse proxy rules + automatic HTTPS
├── openclaw.Dockerfile        # Extends official OpenClaw image; installs plugins
├── docker-entrypoint.sh       # Syncs config/openclaw.json into the state volume, then starts gateway
└── package.json               # Root npm workspace (lib + services/setup-ui)
```

---

## Services

### OpenClaw gateway

Built from `openclaw.Dockerfile`. Extends the official `ghcr.io/openclaw/openclaw:latest` image (Node 24, tini as PID 1).

**Why a custom Dockerfile?**

Docker volumes mask image-layer files at the mounted path, so the versioned `config/openclaw.json` cannot simply be `COPY`'d and expected to be visible inside the volume at runtime. The `docker-entrypoint.sh` script solves this by copying the config file into the mounted volume on every container start before handing off to the gateway process.

**Startup sequence (`docker-entrypoint.sh`):**

1. `mkdir -p /home/node/.openclaw`
2. `cp /app/config/openclaw.json /home/node/.openclaw/openclaw.json`
3. `exec node openclaw.mjs gateway`

The container is declared with `user: "0:0"` in `docker-compose.yml` (runs as root) so the entrypoint has write access to the named volume.

**Installed plugins:**

`plugins/webex` is copied into `/app/plugins/` at build time. The root `package.json` npm workspace and `lib/` are also copied so `npm install --workspaces` can create the `@collab/*` symlinks that plugins import at runtime.

**Healthcheck:**

```
GET https://claw.asabizanjo.dev/healthz
```

---

### Webex channel plugin

Located at `plugins/webex/`. Registered with OpenClaw via `openclaw.plugin.json` and loaded through the `plugins.load.paths` entry in `config/openclaw.json`.

#### Module overview

| File | Responsibility |
|---|---|
| `index.js` | Plugin entry — calls `api.registerChannel` and `api.registerHttpRoute` |
| `channel.js` | Full OpenClaw channel contract: account resolution, DM policy, outbound send, status/probe, `startAccount` lifecycle |
| `inbound.js` | Post-webhook async handler: filters self/DM/membership, fetches full message, dispatches to agent pipeline |
| `webhook.js` | `webhookRouter` HTTP handler: HMAC-SHA1 verification, body read, target dispatch registry |
| `token.js` | In-memory OAuth access token; `ensureWebhook` (deregister-then-recreate); `deregisterWebhooks`; 12-day refresh interval |
| `send.js` | `buildMsgBody` — infers `roomId` vs `toPersonId` vs `toPersonEmail` from the `to` string |
| `api.js` | `WEBEX_API` constant; `webexFetch` authenticated fetch helper |

#### Account lifecycle (`channel.js → startAccount`)

1. Sets the in-memory OAuth access token (`token.js`).
2. Fetches bot identity (`/people/me`) to get `botId` for self-message filtering.
3. Starts a `setInterval` every 12 days to refresh the OAuth access token (tokens last ~14 days; Webex auto-renews the refresh token).
4. Calls `ensureWebhook` — deletes any existing webhooks pointing at `cfg.webhookUrl`, then creates a fresh one for `resource: messages, event: created`.
5. Registers a path entry in the `targets` Map (keyed by `/webhooks/webex/default`) so `webhookRouter` can dispatch incoming POSTs.
6. Suspends in `await new Promise(() => {})` — the channel is long-lived.
7. `finally` block: clears the refresh interval, removes the target, calls `deregisterWebhooks`.

#### Inbound message flow (`inbound.js → handleInbound`)

1. Ignore anything that isn't `resource: messages, event: created`.
2. Ignore messages from the bot's own `personId`.
3. Apply DM policy: `deny` blocks all DMs, `allow` lets all through, `allowlisted` checks `cfg.allowFrom` against `personId` or `personEmail`.
4. Fetch the full message via `/messages/:id` (webhooks only carry IDs).
5. Confirm bot membership in the space via `/memberships?roomId=...&personId=...`.
6. Build a context payload and call `dispatchReplyWithBufferedBlockDispatcher` on the OpenClaw plugin runtime.

**Context payload fields:**

| Field | Value |
|---|---|
| `Body` / `RawBody` / `CommandBody` | `msg.text` |
| `From` | `webex:<personId>` |
| `To` | `webex:<roomId>` |
| `SessionKey` | `agent:main:webex:<roomId>` |
| `ChatType` | `direct` or `group` |
| `SenderName` | `msg.personEmail` (falls back to `personId`) |
| `MessageThreadId` | `msg.parentId` (thread parent) |
| `IsMentioned` | `true` if the bot's ID is in `msg.mentionedPeople` |

#### Webhook route (`webhook.js`)

Registered at `/webhooks/webex/` with `match: prefix` and `auth: plugin`. Handles only `POST`; returns `405` otherwise.

**HMAC verification:**
Reads the raw body bytes, computes `HMAC-SHA1(webhookSecret, rawBody)`, compares with the `X-Spark-Signature` header using `timingSafeEqual`. If no `webhookSecret` is configured, verification is skipped.

After verifying and parsing the body, the handler immediately responds `200 {"ok":true}` (Webex requires a fast acknowledgement) and then calls `target.handle(payload)` asynchronously.

#### DM allowlist

Currently restricted to:
- `ucabtg2@ucl.ac.uk`
- `ucab295@ucl.ac.uk`
- `davit.gevorgyan.25@ucl.ac.uk`
- `leonardo.martin.25@ucl.ac.uk`

Configured in `config/openclaw.json` under `channels.webex.allowFrom`. Edit that file and redeploy to change.

---

### Meeting Join plugin

`plugins/meeting-join` lets a Webex space member mention the bot with a natural-language meeting request (for example, `@bot join the meeting`). It stores invitation credentials outside the agent context, then uses a dedicated licensed Webex user and the Webex Meetings SDK in an OpenClaw-managed headless browser.

- The invitation can be in the request or the latest stored invitation from the same space.
- Phase 1 joins without microphone, camera, screen-share, or media processing.
- `@bot leave the meeting` ends that space's active session; meeting-end and container-restart recovery are handled automatically.
- OAuth, invitation, and active-session state are encrypted in the persistent OpenClaw volume using `MEETING_JOIN_ENCRYPTION_KEY`.
- A maximum of four sessions is configured by default, with one active meeting per space.

The `MEETING_JOIN_*` variables in `.env.example` must be supplied before enabling it in production. The Docker image uses OpenClaw's browser variant and enables the loopback-only browser-control server.

### Setup UI

Located at `services/setup-ui/`. A single-page React form served by an Express backend. Reached at `https://<DOMAIN>/setup?spaceId=<webex-room-id>`.

The `spaceId` query parameter is the Webex room ID — the bot is expected to send the setup link to new spaces. If `spaceId` is missing the form shows an error and blocks submission.

#### What it does

1. User fills in: project name, one or more repos (first is always primary), and team members (name, email, role).
2. User clicks the **Authorise on GitHub** link to install the GitHub App on the listed repos.
3. User submits the form.
4. The server validates the payload, then uses `@collab/github` to write into the **primary repo**:
   - `.collab/config.json` — project metadata (name, spaceId, repos, members, `createdAt`)
   - `.collab/context.md` — created only if it doesn't already exist
   - `.collab/open-questions.md` — created only if it doesn't already exist
   - `.collab/issues.md` — created only if it doesn't already exist
5. On success the form shows a "Setup complete" banner.

#### Server routes

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Container healthcheck — returns `{ ok: true }` |
| `GET` | `/setup` | Serves the compiled React app (`dist/index.html`) |
| `GET` | `/api/config` | Returns `{ appName }` (the `GITHUB_APP_NAME` env var) used by the client to build the GitHub install URL |
| `POST` | `/api/setup` | Validates form payload, writes `.collab/` files to the primary repo via GitHub API |

#### POST `/api/setup` payload

```json
{
  "spaceId": "<webex-room-id>",
  "project": "My Project",
  "repos": [
    { "url": "owner/repo", "name": "Frontend", "primary": true },
    { "url": "owner/other-repo", "name": "Backend", "primary": false }
  ],
  "members": [
    { "name": "Alice", "email": "alice@example.com", "role": "Lead" }
  ]
}
```

Validation rules:
- `spaceId` — required non-empty string
- `project` — required non-empty string
- `repos` — at least one entry; exactly one must have `primary: true`; primary repo URL must be `owner/repo` format
- `members` — at least one entry

#### Client build

Vite builds from `client/` into `services/setup-ui/dist/`. The Dockerfile runs the build at image build time; the Express server serves `dist/` as static files.

**Dockerfile note:** the build context is the **repo root** (not `services/setup-ui/`), because the Vite build and server both need `lib/` to be available for the `@collab/github` workspace symlink.

#### Environment variables

| Variable | Description | Default |
|---|---|---|
| `GITHUB_APP_NAME` | GitHub App slug — used by the client to build the install URL | — |
| `GITHUB_APP_ID` | GitHub App ID — used by `@collab/github` to mint JWTs | — |
| `GITHUB_APP_PRIVATE_KEY_FILE` | Path to the mounted PEM file | `/run/secrets/github-app-private-key.pem` |
| `PORT` | Port the Express server listens on | `3000` |

---

### Caddy reverse proxy

Image: `caddy:2`. The only service with public ports (`80:80`, `443:443`).

**Routing (from `Caddyfile`):**

| Path pattern | Upstream |
|---|---|
| `/setup*`, `/api/*` | `setup-ui:3000` |
| everything else | `openclaw:18789` |

Caddy holds the static IP `172.28.0.10` on the `collab` network. This IP is declared in `config/openclaw.json` under `gateway.trustedProxies` so the gateway trusts the `X-Forwarded-For` header and sees real client IPs. **If you change the `collab` network subnet in `docker-compose.yml`, update `trustedProxies` to match.**

TLS certificates are obtained automatically from Let's Encrypt on first request and renewed by Caddy. The `caddy_data` volume persists the ACME account and issued certificates across restarts.

WebSocket connections (OpenClaw Control UI live updates) are proxied transparently.

---

## Shared library — `@collab/github`

Located at `lib/github.js`. A Node.js CommonJS module that wraps the GitHub REST API using GitHub App authentication.

**Authentication flow:**

1. `createJWT()` — mints a short-lived JWT (10 min) signed with the App's RSA-256 private key. The key is read from the path in `GITHUB_APP_PRIVATE_KEY_FILE` (preferred) or from the `GITHUB_APP_PRIVATE_KEY` env var (inline PEM with `\n` escapes).
2. `getInstallationId(owner, repo)` — calls `GET /repos/:owner/:repo/installation` with the JWT to find the installation ID for that repo.
3. `getInstallationToken(owner, repo)` — exchanges the JWT + installation ID for an installation access token. Tokens are cached per `owner/repo` and reused until they have less than 5 minutes left.

**Exported functions:**

| Function | Description |
|---|---|
| `getInstallationToken(owner, repo)` | Returns a scoped installation access token |
| `readFile(owner, repo, path)` | Reads a file from the repo; returns `null` if 404 |
| `writeFile(owner, repo, path, content, commitMessage)` | Creates or updates a file (fetches existing SHA for updates) |
| `listFiles(owner, repo, path)` | Lists file names at a directory path; returns `[]` if 404 |
| `getCommitsSince(owner, repo, since)` | Returns commits after an ISO timestamp |
| `getCommitDiff(owner, repo, sha)` | Returns the raw diff for a commit (accepts `application/vnd.github.diff`) |
| `createPullRequest(owner, repo, { title, body, head, base })` | Creates a PR; returns the HTML URL |

This library is used by `services/setup-ui/server.js` (`readFile`, `writeFile`) and is available to any other service or plugin that needs GitHub API access.

---

## Gateway configuration

`config/openclaw.json` is the versioned source of truth for the OpenClaw gateway. It is committed to the repo and copied into the state volume on every container start by `docker-entrypoint.sh`. Environment variables are interpolated using `${VAR_NAME}` syntax by OpenClaw at startup.

**Key sections:**

```jsonc
{
  "gateway": {
    "mode": "local",
    "controlUi": {
      "allowedOrigins": ["${CONTROL_UI_ORIGIN}"],
      "dangerouslyDisableDeviceAuth": true   // token-only auth; no device pairing
    },
    "auth": { "mode": "token", "token": "${OPENCLAW_GATEWAY_TOKEN}" },
    "trustedProxies": ["172.28.0.10"]        // Caddy's fixed IP on the collab network
  },
  "models": {
    "mode": "merge",
    "providers": {
      "cisco": {
        "baseUrl": "https://llm-proxy.dev.outshift.ai/",
        "apiKey": "${CISCO_LLM_API_KEY}",
        "api": "openai-completions",
        "models": [
          { "id": "bedrock/global.anthropic.claude-sonnet-4-6",              "name": "Claude Sonnet 4.6" },
          { "id": "bedrock/global.anthropic.claude-haiku-4-5-20251001-v1:0", "name": "Claude Haiku 4.5" },
          { "id": "azure/gpt-5.4",                                           "name": "GPT-5.4" },
          { "id": "vertex_ai/gemini-3-pro-preview",                          "name": "Gemini 3 Pro Preview" }
        ]
      }
    }
  },
  "agents": {
    "defaults": { "model": { "primary": "cisco/bedrock/global.anthropic.claude-sonnet-4-6" } },
    "list": [{ "id": "main", "default": true }]
  },
  "bindings": [
    { "agentId": "main", "match": { "channel": "webex" } }   // all Webex messages → main agent
  ],
  "channels": {
    "webex": {
      "enabled": true,
      "token": "${WEBEX_BOT_TOKEN}",
      "accessToken": "${WEBEX_ACCESS_TOKEN}",
      "refreshToken": "${WEBEX_REFRESH_TOKEN}",
      "clientId": "${WEBEX_CLIENT_ID}",
      "clientSecret": "${WEBEX_CLIENT_SECRET}",
      "webhookUrl": "${WEBEX_WEBHOOK_URL}",
      "webhookSecret": "${WEBEX_WEBHOOK_SECRET}",
      "dmPolicy": "allowlisted",
      "allowFrom": ["ucabtg2@ucl.ac.uk", "ucab295@ucl.ac.uk", ...]
    }
  },
  "hooks": {
    "enabled": true,
    "token": "${OPENCLAW_WEBHOOK_SECRET}",
    "path": "/hooks",
    "allowRequestSessionKey": true,
    "allowedSessionKeyPrefixes": ["agent:main:webex:", "hook:"],
    "defaultSessionKey": "hook:collab-sync"
  },
  "plugins": {
    "load": { "paths": ["plugins/webex"] },
    "entries": { "webex": { "enabled": true } }
  }
}
```

To change gateway configuration, edit `config/openclaw.json` and redeploy. The entrypoint will sync the new config into the volume on next start.

---

## Environment variables

All variables live in `.env` (gitignored). Copy `.env.example` to `.env` and fill in every value before the first launch.

| Variable | Used by | Notes |
|---|---|---|
| `DOMAIN` | Caddy | Public hostname with DNS A record pointing at the VPS |
| `ACME_EMAIL` | Caddy | Let's Encrypt expiry/renewal contact email |
| `CONTROL_UI_ORIGIN` | openclaw | Must be exactly `https://claw.asabizanjo.dev` (no trailing slash) |
| `OPENCLAW_GATEWAY_TOKEN` | openclaw | Admin token for the Control UI — `openssl rand -hex 32` |
| `OPENCLAW_GATEWAY_PORT` | openclaw | Internal listen port (default `18789`) |
| `OPENCLAW_GATEWAY_BIND` | openclaw | Network bind mode (`lan`) |
| `OPENCLAW_STATE_DIR` | openclaw | Where the gateway persists state (`/home/node/.openclaw`) |
| `OPENCLAW_WORKSPACE_DIR` | openclaw | Workspace subdirectory (`/home/node/.openclaw/workspace`) |
| `PORT` | openclaw / setup-ui | HTTP port — `18789` for openclaw, `3000` for setup-ui |
| `OPENCLAW_WEBHOOK_SECRET` | openclaw | Protects `/hooks` endpoint — `openssl rand -hex 32` |
| `CISCO_LLM_API_KEY` | openclaw | Cisco LLM proxy API key |
| `WEBEX_BOT_TOKEN` | openclaw | Webex bot access token (used for sending messages) |
| `WEBEX_ACCESS_TOKEN` | openclaw | OAuth access token (used for reading messages) |
| `WEBEX_REFRESH_TOKEN` | openclaw | OAuth refresh token — refreshed automatically every 12 days |
| `WEBEX_CLIENT_ID` | openclaw | Webex Integration client ID (for token refresh) |
| `WEBEX_CLIENT_SECRET` | openclaw | Webex Integration client secret (for token refresh) |
| `WEBEX_WEBHOOK_SECRET` | openclaw | HMAC-SHA1 secret Webex signs webhook POSTs with — `openssl rand -hex 32` |
| `WEBEX_WEBHOOK_URL` | openclaw | Must be `https://claw.asabizanjo.dev/webhooks/webex/default` |
| `GITHUB_APP_ID` | setup-ui | Numeric GitHub App ID |
| `GITHUB_APP_NAME` | setup-ui | GitHub App slug (shown in the install URL) |
| `GITHUB_APP_PRIVATE_KEY_FILE` | setup-ui | Path to the mounted PEM — `/run/secrets/github-app-private-key.pem` |

Generate the three random secrets in one go:

```bash
openssl rand -hex 32   # OPENCLAW_GATEWAY_TOKEN
openssl rand -hex 32   # OPENCLAW_WEBHOOK_SECRET
openssl rand -hex 32   # WEBEX_WEBHOOK_SECRET
```

---

## Deployment

### Prerequisites

- An Ubuntu VPS (22.04 or 24.04; 2 GB RAM is comfortable).
- Docker Engine + Compose plugin installed.
- A domain (or subdomain) with a DNS **A record** pointing at the VPS public IP. A bare IP does not work — Webex webhooks and Let's Encrypt both require a real HTTPS hostname.
- Ports **80** and **443** open in the firewall.

### Server setup

```bash
# Install Docker
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER   # log out and back in
docker compose version          # confirm the compose plugin is present

# Open firewall
sudo ufw allow OpenSSH
sudo ufw allow 80,443/tcp
sudo ufw enable

# Clone the repo
sudo mkdir -p /opt/real-time-agent-collab
sudo chown $USER:$USER /opt/real-time-agent-collab
git clone <repo-url> /opt/real-time-agent-collab
cd /opt/real-time-agent-collab

# Configure secrets
cp .env.example .env
nano .env   # fill in every variable

# Mount the GitHub App private key
mkdir -p secrets
nano secrets/github-app-private-key.pem   # paste the full -----BEGIN...END----- block
```

`secrets/` is gitignored and never committed.

### First launch

```bash
docker compose up -d --build
docker compose ps
docker compose logs -f caddy      # watch Let's Encrypt obtain the certificate (~30s)
```

Once Caddy has a certificate:

```bash
curl -fsS https://claw.asabizanjo.dev/healthz   # expect {"ok":true} from the gateway
```

Open the **Control UI** at `https://claw.asabizanjo.dev/openclaw` and log in with `OPENCLAW_GATEWAY_TOKEN`.

### Auto-deploy on push

`.github/workflows/deploy.yml` SSHes into the VPS on every push to `main`, fast-forwards the checkout, and runs `scripts/deploy.sh` (`docker compose up -d --build` + image prune).

Set these **repository secrets** in GitHub → Settings → Secrets and variables → Actions:

| Secret | Value |
|---|---|
| `VPS_HOST` | VPS IP or hostname |
| `VPS_USER` | SSH user (e.g. `deploy`) |
| `VPS_SSH_KEY` | Contents of the SSH private key authorised on the VPS |
| `DEPLOY_PATH` | Absolute path on the VPS (e.g. `/opt/real-time-agent-collab`) |
| `VPS_PORT` | SSH port if not `22` (optional) |

**Generate an SSH key pair for CI:**

```bash
ssh-keygen -t ed25519 -f deploy_key -N ""
ssh-copy-id -i deploy_key.pub ixn@vps.asabizanjo.dev
# Upload the private key (deploy_key) as VPS_SSH_KEY in GitHub
```

To deploy manually at any time:

```bash
ssh ixn@vps.asabizanjo.dev
cd /opt/real-time-agent-collab && git pull && bash scripts/deploy.sh
```

---

## Operations cheatsheet

```bash
docker compose ps                          # container status
docker compose logs -f openclaw            # gateway logs
docker compose logs -f setup-ui            # setup UI logs
docker compose logs -f caddy               # proxy / TLS logs
docker compose restart openclaw            # restart one service
docker compose up -d --build               # rebuild after a code change
docker compose down                        # stop everything (state volume is preserved)

# Backup the persistent state volume
docker run --rm \
  -v real-time-agent-collab_openclaw_state:/data \
  -v "$PWD":/backup \
  busybox tar czf /backup/openclaw_state.tar.gz -C /data .
```

---

## Troubleshooting

**Caddy can't get a TLS certificate**
DNS not pointing at the VPS yet, or ports 80/443 blocked. Check:
```bash
docker compose logs caddy
sudo ss -tlnp | grep -E ':(80|443)'
dig +short claw.asabizanjo.dev   # must print the VPS IP
```

**Control UI rejects the browser origin**
`CONTROL_UI_ORIGIN` must be exactly `https://claw.asabizanjo.dev` with no trailing slash and no path.

**Gateway sees wrong client IP / proxy errors**
`trustedProxies` in `config/openclaw.json` must match Caddy's IP on the `collab` network (`172.28.0.10`). If you changed the subnet in `docker-compose.yml`, update both places.

**Webex messages not arriving**
The gateway re-registers the Webex webhook on every start (`plugins/webex/token.js → ensureWebhook`). Check:
- `WEBEX_WEBHOOK_URL` is exactly `https://claw.asabizanjo.dev/webhooks/webex/default`.
- The domain resolves and port 443 is reachable from the internet.
- `docker compose logs openclaw` should show `[webex:default] Webex webhook registered` and `[webex] webhookRouter called` on incoming messages.

**DMs not reaching the agent**
The channel is set to `dmPolicy: allowlisted`. The sender's email or Webex `personId` must be in `channels.webex.allowFrom` in `config/openclaw.json`.

**GitHub App calls fail in setup-ui**
- Confirm `secrets/github-app-private-key.pem` exists and is the correct PEM for the App.
- Confirm `GITHUB_APP_ID` matches the App ID in the GitHub App settings.
- The GitHub App must be installed on the target repo before `POST /api/setup` can write to it.
- Check `docker compose logs setup-ui` for the specific error.

**Setup UI form has no GitHub authorisation button**
`GITHUB_APP_NAME` is not set. The client calls `GET /api/config` to get the slug; without it the install URL cannot be built.

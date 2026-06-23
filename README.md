# Real-Time Agent Collaboration

## Repo structure

```
real-time-agent-collab/
├── config/
│   └── openclaw.json          # versioned gateway config
├── docs/                      # architecture diagrams, design notes
├── plugins/webex/             # Webex channel plugin
├── lib/                       # shared @collab/* packages (e.g. github)
├── services/setup-ui/         # onboarding web app (Express + Vite/React)
├── scripts/deploy.sh          # rebuild + restart the stack on the VPS
├── secrets/                   # gitignored, local only — do not commit
│   └── github-app-private-key.pem
├── .github/workflows/deploy.yml  # auto-deploy to the VPS on push to main
├── .env.example               # copy to .env (gitignored) and fill in
├── docker-compose.yml         # VPS stack: caddy + openclaw + setup-ui
├── Caddyfile                  # reverse proxy + automatic HTTPS
├── openclaw.Dockerfile        # extends official OpenClaw image
└── docker-entrypoint.sh       # syncs config into volume, then starts gateway
```

## Deployment

The system runs on an **Ubuntu VPS** via Docker Compose. Three containers sit
behind a Caddy reverse proxy that terminates TLS (automatic Let's Encrypt
certificates):

| Container  | Role                                                                    |
| ---------- | ----------------------------------------------------------------------- |
| `caddy`    | Public entrypoint on :80/:443, automatic HTTPS for `${DOMAIN}`          |
| `openclaw` | OpenClaw gateway — `/openclaw`, `/healthz`, `/hooks`, `/webhooks/webex/*` |
| `setup-ui` | Onboarding web app — `/setup`, `/api/*`                                  |

The versioned `config/openclaw.json` is the source of truth for gateway
configuration — synced into the persistent volume on every container start by
`docker-entrypoint.sh`. All secrets live in a gitignored `.env`.

See **[docs/vps-migration.md](docs/vps-migration.md)** for the full step-by-step
server setup. Quick reference below.

### Prerequisites

- An Ubuntu VPS with Docker Engine + Compose plugin installed.
- A domain (or subdomain) with a DNS **A record** pointing at the VPS public IP
  (required — Webex webhooks and Let's Encrypt need a real hostname).
- Ports **80** and **443** open in the firewall.

### One-time server setup

```bash
git clone <repo-url> /opt/real-time-agent-collab
cd /opt/real-time-agent-collab

cp .env.example .env          # fill in DOMAIN, tokens, Webex + Cisco keys
mkdir -p secrets              # gitignored
# place the GitHub App private key here:
#   secrets/github-app-private-key.pem

docker compose up -d --build
```

Caddy obtains a certificate automatically on first start (give it ~30s). State
lives in the `openclaw_state` Docker volume and survives rebuilds.

### Environment variables

All variables live in `.env` (copied from `.env.example`). Key ones:

| Variable                  | Notes                                                            |
| ------------------------- | --------------------------------------------------------------- |
| `DOMAIN` / `ACME_EMAIL`   | Public hostname + Let's Encrypt contact (used by Caddy)         |
| `CONTROL_UI_ORIGIN`       | `https://<DOMAIN>` — the Control UI's allowed browser origin    |
| `WEBEX_WEBHOOK_URL`       | `https://<DOMAIN>/webhooks/webex/default`                       |
| `OPENCLAW_GATEWAY_TOKEN`  | Admin token — generate with `openssl rand -hex 32`              |
| `OPENCLAW_WEBHOOK_SECRET` | Protects `/hooks` — `openssl rand -hex 32`                      |
| `CISCO_LLM_API_KEY`       | Cisco LLM proxy key                                             |
| `WEBEX_*`                 | Bot/OAuth tokens, client id/secret, webhook HMAC secret        |
| `GITHUB_APP_*`            | App id/name; private key mounted from `secrets/` (see `.env.example`) |

### Auto-deploy on push

`.github/workflows/deploy.yml` SSHes into the VPS on every push to `main`,
fast-forwards the checkout, and runs `scripts/deploy.sh` (`docker compose up -d
--build`). Configure these repository secrets: `VPS_HOST`, `VPS_USER`,
`VPS_SSH_KEY`, `DEPLOY_PATH` (and optionally `VPS_PORT`).

To deploy manually instead: `bash scripts/deploy.sh` on the server.

### Accessing the Control UI

```
https://<your-domain>/openclaw
```

Enter the `OPENCLAW_GATEWAY_TOKEN` when prompted. Device pairing is disabled via
`gateway.controlUi.dangerouslyDisableDeviceAuth: true` in `config/openclaw.json`
— token auth alone is sufficient.

### Verifying the deployment

```bash
curl -fsS https://<your-domain>/healthz
docker compose ps
docker compose logs -f openclaw
```


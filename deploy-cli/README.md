# deploy-cli

The deterministic deployment control surface that runs **on the target VPS**. The
OpenClaw deploy agent invokes its typed subcommands over SSH (as a forced
command, so the agent can never open a shell). It clones/updates a repo, builds
it (Dockerfile if present, otherwise [nixpacks](https://nixpacks.com)
auto-detection), runs it behind the Caddy reverse proxy, and tracks every app in
a local SQLite registry.

Every command prints **one JSON object** to stdout — success or failure — so the
agent parses a single deterministic shape instead of scraping human text. Exit
code is `0` on success, `1` on a handled failure, `2` on a usage error.

## End-to-end setup

Two VPSes are involved and each needs its own steps: the **target VPS** (a fresh
box that will host deployed apps) and the **OpenClaw VPS** (where the collab
agent already runs, from the repo root). Do Part A first, then Part B, then Part C.

### Two keys — do not confuse them

- **Your existing admin key** (e.g. an AWS `.pem`) — this is *you*, a human, doing
  one-time root/sudo provisioning on the target VPS. It is used once, manually,
  and never touches OpenClaw or `.env`.
- **`deploy-vps-key`** — a *brand-new* keypair generated below, used only by the
  OpenClaw agent. It is installed on the target VPS locked to a forced command
  (`command="deploy-cli-forced"` in `authorized_keys`) for a low-privilege
  `deploy` user, so even a misused or leaked key can only ever run `deploy-cli`
  subcommands — never open a shell, never do anything your admin key can.

Never reuse your admin key for the agent, and never let the agent's key have
unrestricted shell access — that restriction is the entire security model this
CLI is built around.

### Part A — Target VPS

**A1. Generate the agent's dedicated keypair** (run locally, from the repo root
— not on either VPS):

```bash
mkdir -p secrets
ssh-keygen -t ed25519 -f secrets/deploy-vps-key -N "" -C "deploy-agent"
chmod 600 secrets/deploy-vps-key
```

**A2. Get this repo onto the target VPS**, using your existing admin key:

```bash
scp -i your-admin-key.pem -r . ubuntu@<target-vps-ip>:/opt/real-time-agent-collab
# or SSH in and `git clone` the repo there instead
```

Only `deploy-cli/`, `deploy-infra/`, and `scripts/bootstrap-target-vps.sh` are
actually needed on this box — copying the whole repo is simplest.

**A3. Run the bootstrap script**, still via your admin key, as root:

```bash
ssh -i your-admin-key.pem ubuntu@<target-vps-ip>
cd /opt/real-time-agent-collab
sudo ACME_EMAIL=you@example.com \
     DEPLOY_AGENT_PUBKEY="$(cat secrets/deploy-vps-key.pub)" \
     bash scripts/bootstrap-target-vps.sh
```

This installs Docker, nixpacks, the `deploy-cli` binary, the
`caddy-docker-proxy` reverse proxy, `/opt/apps` + the SQLite registry, and the
locked-down `deploy` user (whose only capability is running `deploy-cli`, via
the key from A1). It is idempotent — safe to re-run any time to pick up changes.

It ends by printing something like:

```
==> Done. Apps will be served at <name>.203-0-113-45.sslip.io
==> Add this to the openclaw .env:  DEPLOY_VPS_HOST + DEPLOY_DOMAIN_SUFFIX=203-0-113-45.sslip.io
```

**Copy that domain suffix down** — it's needed in Part C. Leave
`DEPLOY_DOMAIN_SUFFIX` unset when invoking bootstrap unless you already own a
domain — it auto-derives a free `<ip-with-dashes>.sslip.io` hostname.

### Part B — OpenClaw VPS

**B1.** Confirm `secrets/deploy-vps-key` (from A1) exists on this box too —
`docker-compose.yml` mounts it from `./secrets/`, alongside the GitHub App PEM
that's already there.

**B2.** Rebuild the openclaw stack so the Dockerfile's `openssh-client` install
and the new compose mounts (`skills/`, `deploy-vps-key`) take effect:

```bash
git pull
docker compose up -d --build openclaw
```

### Part C — Fill in `.env` on the OpenClaw VPS

Five lines, already present and blank in `.env.example`:

| Var | Value |
|---|---|
| `DEPLOY_VPS_HOST` | the **target** VPS's public IP (from Part A) |
| `DEPLOY_VPS_USER` | `deploy` — leave as default |
| `DEPLOY_VPS_PORT` | `22` — leave as default unless the target VPS uses a different port |
| `DEPLOY_VPS_KEY` | `/run/secrets/deploy-vps-key` — leave as default, matches the compose mount |
| `DEPLOY_DOMAIN_SUFFIX` | exactly what bootstrap printed in A3, e.g. `203-0-113-45.sslip.io` |

Re-run B2's `docker compose up -d --build openclaw` after editing `.env` if you
haven't already, so the container picks up the change.

Once done, the `deploy-app` skill activates for the agent (it's gated on
`DEPLOY_VPS_HOST` being set) — try asking it to deploy a small public repo as a
smoke test, or ask it for `host_resources` / `list_apps` to confirm connectivity.

## Commands

| Command | Flags | Description |
|---|---|---|
| `deploy` | `--name --repo [--ref] [--env-file] [--token] [--by]` | Deploy a new app. Fails if the slug already exists. |
| `redeploy` | same as `deploy` | Update an existing app (pull, rebuild, swap). Fails if it doesn't exist. |
| `list` | — | All registered apps. |
| `status` | `--name` | Registry row + live container state (which can drift from the recorded status). |
| `stop` | `--name [--by]` | Stop the container. |
| `start` | `--name [--by]` | Start a stopped container. |
| `remove` | `--name [--by]` | Tear down container, checkout, env file, and registry row. |
| `url` | `--name` | Public URL of an app. |
| `logs` | `--name [--tail]` | Trailing container logs. |
| `ports` | — | An unused TCP port (for the rare non-HTTP service). |
| `resources` | — | Host memory/disk/CPU snapshot + whether it's over capacity. |
| `health` | — | Confirms Docker is reachable and the registry opens. |

**Env file precedence** (`--env-file`): explicit content the agent supplies
(`--env-file <path>` or `--env-file -` for stdin, written to a private
`0600` file) → a `.env` committed in the repo → a previously supplied env file
for that app. Secrets never pass through argv; use stdin.

**Private repos**: pass `--token` (a GitHub App installation token or PAT). It is
injected into the clone URL only on the git process's argv, scrubbed from the
stored remote afterward, and never written to the registry or audit log.

## Configuration (environment)

| Var | Default | Description |
|---|---|---|
| `DEPLOY_DOMAIN_SUFFIX` | *(required)* | Host suffix, e.g. `203-0-113-1.sslip.io`. App URL = `<name>.<suffix>`. |
| `DEPLOY_APPS_DIR` | `/opt/apps` | Per-app checkouts. |
| `DEPLOY_ENV_DIR` | `/opt/apps/.env-store` | Private per-app env files (`0600`). |
| `DEPLOY_REGISTRY_DB` | `/opt/apps/.registry/registry.db` | SQLite registry (WAL). |
| `DEPLOY_AUDIT_LOG` | `/opt/apps/.registry/deploy-audit.jsonl` | Append-only action log. |
| `DEPLOY_NETWORK` | `caddy` | Docker network shared with caddy-docker-proxy. |
| `DEPLOY_PORT` | `3000` | Container port apps listen on (`PORT` env + proxy upstream). |
| `DEPLOY_MEM_MB` | `512` | Per-app memory cap. |
| `DEPLOY_CPUS` | `0.5` | Per-app CPU cap. |
| `DEPLOY_RESTART` | `unless-stopped` | Container restart policy. |
| `DEPLOY_MAX_MEM_PCT` | `90` | Refuse new deploys above this memory usage. |
| `DEPLOY_MAX_DISK_PCT` | `90` | Refuse new deploys above this disk usage. |

## Build

```bash
# Native
go build -o deploy-cli .

# For the target VPS (pure-Go SQLite, static, no cgo)
GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -o deploy-cli .

go test ./...
```

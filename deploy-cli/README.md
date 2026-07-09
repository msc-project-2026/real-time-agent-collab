# deploy-cli

This is the piece that lets our OpenClaw agent actually *ship* apps. Someone
messages the bot on Webex ("deploy github.com/foo/bar"), and a few seconds later
they get back a live HTTPS URL. This CLI is what does the real work at the other
end of that.

I want to be upfront about the shape of it, because the design is the whole
point. The agent never runs a shell, never runs `docker`, never touches the
host directly. It can only call the typed subcommands you see below, over SSH,
against a key that is physically incapable of doing anything else. Everything in
here follows from that constraint.

Read this if you're setting the system up, debugging a deploy that went sideways,
or just trying to understand how a chat message turns into a running container.

---

## The 30-second mental model

Two machines are involved and it's worth keeping them straight from the start:

- **The OpenClaw VPS** — where our collab bot already lives (the Webex gateway,
  the agents, all of it). This box *decides* to deploy something.
- **The target VPS** — a separate box whose only job is to host the apps we
  deploy. This is where `deploy-cli` lives and where the containers actually run.

We deliberately keep these apart. If a deployed app misbehaves or eats all the
CPU, it does that on the target box, nowhere near the bot.

The flow, end to end:

```
Webex user
   │  "deploy this repo"
   ▼
main agent  (Sonnet, on the OpenClaw VPS)
   │  request_deployment
   ▼
deployer agent  (Haiku — cheap, does the routine calls)
   │  deploy_app / redeploy_app / list_apps / ...
   ▼
ssh.js  ──SSH──►  target VPS
                     │  sshd forced command
                     ▼
                  deploy-cli  ──►  git clone → build → docker run → Caddy
                     │
                     ▼
                  https://<name>.<suffix>
```

If a deploy fails, the deployer agent doesn't burn tokens flailing at it — it
escalates to a **debugger agent** (Sonnet again) that reads the logs, makes one
fix, and retries. More on that tiering below.

---

## How it actually works

### Everything is one JSON object

Every command prints **exactly one JSON object** to stdout, whether it succeeded
or failed, and then exits. Success looks like `{"ok": true, ...}`, failure like
`{"ok": false, "error": "..."}`. Exit codes: `0` success, `1` a handled failure
(the thing we tried didn't work), `2` a usage error (bad flags).

This matters because the caller is a language model, not a person. If the agent
had to scrape human-readable text, it would misread it eventually. Instead it
parses one predictable shape every time. That's also why a failed *deploy* still
returns a full result payload with the build/run logs attached — the debugger
agent needs those logs to figure out what broke, so we hand them over in the same
JSON instead of making it go dig.

### The security model: a key that can only deploy

This is the part I care most about, so read it even if you skim the rest.

There are **two SSH keys** in play and confusing them defeats the entire design:

- **Your admin key** (e.g. an AWS `.pem`) — that's *you*, a human, doing one-time
  root provisioning on the target box. Used once, by hand, never goes near
  OpenClaw or `.env`.
- **`deploy-vps-key`** — a brand-new keypair that *only the agent* uses. On the
  target VPS it's installed against a low-privilege `deploy` user, pinned to a
  **forced command** in `authorized_keys`:

  ```
  command="/usr/local/bin/deploy-cli-forced",no-pty,no-port-forwarding,... ssh-ed25519 AAAA...
  ```

  Because of that `command=` prefix, it does not matter what the agent asks SSH to
  run. sshd ignores the requested command and runs *our* wrapper instead, dropping
  whatever the agent sent into the `SSH_ORIGINAL_COMMAND` env var. The wrapper
  loads config and `exec`s `deploy-cli` — and `deploy-cli` tokenizes
  `SSH_ORIGINAL_COMMAND` **itself, with no shell involved** (see
  [`internal/cli/shellwords.go`](internal/cli/shellwords.go)). There is no `sh -c`
  anywhere in that path, so there's no shell to escape into.

  The upshot: even if this key leaked tomorrow, the worst anyone can do with it is
  run `deploy-cli` subcommands. No shell, no port forwarding, no PTY, no lateral
  movement. That's the guarantee, and it's why the agent's key and your admin key
  must never be the same key.

The `deploy` user is in the `docker` group (the CLI needs the Docker socket to
launch containers), which is a lot of power — but it's bounded by the forced
command to *only* what `deploy-cli` chooses to do with it.

### The build pipeline

When a deploy comes in, [`deploy.go`](internal/deploy/deploy.go) runs a fixed
sequence. Every step shells out through a runner, so there's never any free-form
command construction from agent input:

1. **Validate the slug.** `name` has to be lowercase letters/digits/single
   hyphens — it becomes both the subdomain and the container name, so it can't be
   anything weird.
2. **Capacity check** (new apps only). If the host is already over the memory or
   disk threshold, we refuse *before* doing any work and tell the agent to free
   space. Better a clean "no" than a degraded box. Redeploys skip this since they
   reuse an existing footprint.
3. **Sync the repo.** Shallow `git clone --depth 1` for a new app, or `git fetch`
   + `git reset --hard` for an existing checkout. See the private-repo note below
   for how tokens are handled here.
4. **Resolve the env file** (precedence explained under Commands).
5. **Build the image.** If the repo has a `Dockerfile`, we use it — the author
   knows how they want it built, so we respect that. Otherwise we fall back to
   [**nixpacks**](https://nixpacks.com), which auto-detects the stack
   (`package.json`, `requirements.txt`, `go.mod`, whatever) and produces an image
   with zero language-specific logic on our side. If neither can build it, that's
   a real failure and we surface it with logs — we don't guess.
6. **Swap the container.** Remove the old one, `docker run` the new image on the
   `caddy` network, with the memory/CPU caps, restart policy, `PORT` env, and the
   Caddy routing labels.
7. **Wait for health.** We watch the container for ~15s and, once it's running,
   give it a short settle window to catch immediate crash-loops. A container that
   exits right after start is a failed deploy, not a success.
8. **Record it.** The registry row flips to `running` and we return the URL.

If anything in steps 3–7 fails, the registry row is left as `failed` with the
error recorded, and the result still carries logs.

### TLS just happens

We run [`caddy-docker-proxy`](../deploy-infra) as the reverse proxy. Each app
container gets two labels:

```
caddy               = <name>.<suffix>
caddy.reverse_proxy = {{upstreams 3000}}
```

Caddy watches Docker, sees the label, starts routing that hostname to the
container's port — and because the hostname is declared up front, it provisions a
Let's Encrypt certificate for it automatically over HTTP-01. No cert wrangling on
our end. By default `<suffix>` is a free `sslip.io` hostname derived from the
box's IP (e.g. `203-0-113-45.sslip.io`), so you get real HTTPS without owning a
domain.

### State: a SQLite registry + an audit log

Every app is a row in a small SQLite database (`/opt/apps/.registry/registry.db`,
WAL mode) — name, repo, ref, domain, container, status, last deployed SHA, last
error. That's the source of truth for `list`, `status`, `url`, and for enforcing
"this name is already taken."

Separately, every state-changing action (deploy, redeploy, stop, start, remove)
appends a line to `deploy-audit.jsonl` — who asked, what they asked for, whether
it worked. The `--by` flag is where the requester identity comes from, threaded
all the way from the Webex user through the agents.

I built the SQLite layer on a **pure-Go** driver on purpose, so the binary is a
single static file with `CGO_ENABLED=0` and no libc dependency to fight on the
target box.

### The agent tiering (the OpenClaw side)

This CLI is dumb on purpose — it just does what it's told. The intelligence is in
the [`deploy-agent` plugin](../plugins/deploy-agent), which splits the work across
model tiers so we're not paying Sonnet prices for routine deploys:

- **`request_deployment`** — the main agent (Sonnet) hands the job off with this.
  It doesn't build anything itself; it just packages the request.
- **deployer agent** (Haiku, cheap) — picks up the request and drives the actual
  `deploy_app` / `redeploy_app` / `list_apps` / etc. tools, which are thin typed
  wrappers over SSH calls to this CLI. Routine deploys start and end here.
- **`escalate_debug` → debugger agent** (Sonnet, expensive) — only invoked when a
  deploy comes back `ok:false` and the cheap agent can't fix it with an obvious
  retry. The debugger pulls `app_logs`, diagnoses the real cause (missing env var,
  app not binding to `$PORT`, a repo nixpacks couldn't detect…), applies a fix,
  and redeploys.

The tool *schemas* are the safety boundary on this side: the model can only ever
produce structured, bounded inputs, never a raw command. The forced command is
the boundary on the other side. Two independent walls.

**Secrets never touch the model.** When a user supplies an `.env`, the content is
stashed out-of-band and only pulled back in at the CLI boundary, then piped to the
remote process over **stdin** — never on the command line, never in a prompt,
never in the audit log.

---

## End-to-end setup

Two VPSes, each with its own steps. Do **Part A** (target box) first, then
**Part B** and **Part C** (OpenClaw box).

> Reminder from above: the **admin key** is you doing one-time provisioning; the
> **`deploy-vps-key`** is the agent's locked-down key. Never reuse one for the
> other.

### Part A — Target VPS

**A1. Generate the agent's dedicated keypair** — run this locally from the repo
root, *not* on either VPS:

```bash
mkdir -p secrets
ssh-keygen -t ed25519 -f secrets/deploy-vps-key -N "" -C "deploy-agent"
chmod 600 secrets/deploy-vps-key
```

**A2. Get this repo onto the target VPS** using your admin key:

```bash
scp -i your-admin-key.pem -r . ubuntu@<target-vps-ip>:/opt/real-time-agent-collab
# or just SSH in and `git clone` it there
```

Only `deploy-cli/`, `deploy-infra/`, and `scripts/bootstrap-target-vps.sh` are
actually needed on this box — copying the whole repo is just simplest.

**A3. Run the bootstrap script** via your admin key, as root:

```bash
ssh -i your-admin-key.pem ubuntu@<target-vps-ip>
cd /opt/real-time-agent-collab
sudo ACME_EMAIL=you@example.com \
     DEPLOY_AGENT_PUBKEY="$(cat secrets/deploy-vps-key.pub)" \
     bash scripts/bootstrap-target-vps.sh
```

This does everything to the box in one shot: installs Docker and nixpacks, builds
the `deploy-cli` binary (inside a `golang` container, so you don't need Go on the
host), starts the `caddy-docker-proxy` reverse proxy, creates the `/opt/apps`
layout and the SQLite registry, and sets up the locked-down `deploy` user with the
forced command from A1. It's **idempotent** — re-run it any time to pick up
changes.

It finishes by printing something like:

```
==> Done. Apps will be served at <name>.203-0-113-45.sslip.io
==> Add this to the openclaw .env:  DEPLOY_VPS_HOST + DEPLOY_DOMAIN_SUFFIX=203-0-113-45.sslip.io
```

**Copy that domain suffix down** — you need it in Part C. Leave
`DEPLOY_DOMAIN_SUFFIX` unset when running bootstrap unless you already own a
domain; it'll auto-derive the free `sslip.io` hostname for you.

### Part B — OpenClaw VPS

**B1.** Make sure `secrets/deploy-vps-key` (from A1) exists on this box too —
`docker-compose.yml` mounts it from `./secrets/`, right next to the GitHub App PEM
that's already there.

**B2.** Rebuild the stack so the Dockerfile's `openssh-client` install and the new
compose mounts (`skills/`, `deploy-vps-key`) take effect:

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
| `DEPLOY_VPS_PORT` | `22` — leave as default unless the target box uses another port |
| `DEPLOY_VPS_KEY` | `/run/secrets/deploy-vps-key` — leave as default; matches the compose mount |
| `DEPLOY_DOMAIN_SUFFIX` | exactly what bootstrap printed in A3, e.g. `203-0-113-45.sslip.io` |

Re-run B2's `docker compose up -d --build openclaw` after editing `.env` so the
container picks up the change.

Once that's in, the `deploy-app` skill switches on for the agent (it's gated on
`DEPLOY_VPS_HOST` being set). Ask it to deploy a small public repo as a smoke
test, or ask for `host_resources` / `list_apps` to confirm the SSH path works.

---

## Commands

The agent calls these; you can also run them by hand on the target box while
debugging.

| Command | Flags | What it does |
|---|---|---|
| `deploy` | `--name --repo [--ref] [--env-file] [--token] [--by]` | Deploy a new app. Fails if the slug already exists. |
| `redeploy` | same as `deploy` | Update an existing app (pull, rebuild, swap). Fails if it doesn't exist. |
| `list` | — | Every registered app. |
| `status` | `--name` | Registry row + live container state (they can drift). |
| `stop` | `--name [--by]` | Stop the container. |
| `start` | `--name [--by]` | Start a stopped container. |
| `remove` | `--name [--by]` | Tear down container, checkout, env file, and registry row. |
| `url` | `--name` | An app's public URL. |
| `logs` | `--name [--tail]` | Trailing container logs. |
| `ports` | — | An unused TCP port (for the rare non-HTTP service). |
| `resources` | — | Host memory/disk/CPU snapshot + whether it's over capacity. |
| `health` | — | Confirms Docker is reachable and the registry opens. |

**Env file precedence** (`--env-file`): explicit content the agent supplies
(`--env-file <path>`, or `--env-file -` to read stdin, written to a private `0600`
file) → a `.env` committed in the repo → an env file previously supplied for this
app. Secrets go through stdin, never argv.

**Private repos** (`--token`): pass a GitHub App installation token or a PAT. It's
injected into the clone URL *only* on the git process's argv, scrubbed back out of
the stored remote right after the fetch, and never written to the registry or the
audit log. On the OpenClaw side, the token is minted automatically for private
repos the bot has access to.

---

## Configuration (environment)

Set on the target box (bootstrap writes these to `/etc/deploy-cli.env`).

| Var | Default | Description |
|---|---|---|
| `DEPLOY_DOMAIN_SUFFIX` | *(required)* | Host suffix, e.g. `203-0-113-1.sslip.io`. App URL = `<name>.<suffix>`. |
| `DEPLOY_APPS_DIR` | `/opt/apps` | Per-app checkouts. |
| `DEPLOY_ENV_DIR` | `/opt/apps/.env-store` | Private per-app env files (`0600`). |
| `DEPLOY_REGISTRY_DB` | `/opt/apps/.registry/registry.db` | SQLite registry (WAL). |
| `DEPLOY_AUDIT_LOG` | `/opt/apps/.registry/deploy-audit.jsonl` | Append-only action log. |
| `DEPLOY_NETWORK` | `caddy` | Docker network shared with caddy-docker-proxy. |
| `DEPLOY_PORT` | `3000` | Port apps listen on (`PORT` env + proxy upstream). |
| `DEPLOY_MEM_MB` | `512` | Per-app memory cap. |
| `DEPLOY_CPUS` | `0.5` | Per-app CPU cap. |
| `DEPLOY_RESTART` | `unless-stopped` | Container restart policy. |
| `DEPLOY_MAX_MEM_PCT` | `90` | Refuse new deploys above this memory usage. |
| `DEPLOY_MAX_DISK_PCT` | `90` | Refuse new deploys above this disk usage. |

---

## Building it yourself

Bootstrap already builds and installs the binary on the target box, so you only
need this for local development or a manual install:

```bash
# Native, for hacking on it locally
go build -o deploy-cli .

# For the target VPS: static, pure-Go SQLite, no cgo
GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -o deploy-cli .

go test ./...
```

The layout, if you're finding your way around:

```
main.go                     # entrypoint; hands argv to internal/cli
internal/cli/               # command surface + the shell-word tokenizer for SSH_ORIGINAL_COMMAND
internal/deploy/            # the orchestration core: git sync, build, run, health, registry sync
internal/dockerx/           # thin docker CLI wrapper
internal/registry/          # SQLite app registry
internal/audit/             # append-only JSONL audit log
internal/system/            # host resource reads + capacity thresholds
internal/naming/            # slug validation, domain + container naming
internal/runner/            # the exec seam everything shells out through
```

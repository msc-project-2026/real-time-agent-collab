# Real-Time Agent Collaboration

A human-agent collaboration framework built on [OpenClaw](https://openclaw.ai), developed in partnership with Cisco. The system embeds AI agents as active participants in a software engineering team's shared Webex workspace and development environment, exploring how agents can contribute meaningfully without disrupting the human collaborative flow.

## Overview

The project investigates the middle ground between passive (prompt-only) and overly proactive agent behaviour, designing and evaluating collaboration and interaction patterns for agents operating across a web app development workflow — from design through implementation, debugging, and review.

See the architecture diagrams in `docs/` for a high-level view of the system.

## Repo structure

```
real-time-agent-collab/
├── config/
│   └── openclaw.json       # versioned gateway config
├── docs/                   # architecture diagrams, design notes
├── secrets/                # gitignored, local only — do not commit
│   ├── api-credentials.md
│   ├── collab-agent-token.md
│   └── openclaw-gateway-token.md
├── .gitignore
├── Dockerfile              # extends official OpenClaw image
├── docker-entrypoint.sh    # syncs config into volume, then starts gateway
└── railway.toml            # Railway build/deploy config
```

## Deployment

The system deploys to Railway via Docker, extending the official OpenClaw gateway image (`ghcr.io/openclaw/openclaw:latest`). The versioned `config/openclaw.json` is the source of truth for gateway configuration — synced into the mounted volume on every container start by `docker-entrypoint.sh`.

### One-time Railway setup

**1. Volume** — right-click the service on the Railway canvas → Attach Volume, mounted at:

```
/home/node/.openclaw
```

Persists runtime state (sessions, workspace files) across redeploys. Gateway config is not stored here — it is overwritten from `config/openclaw.json` on every container start.

**2. Public networking** — Service → Settings → Networking → Generate Domain. Required for the Control UI and Webex webhooks.

**3. Environment variables** — set in Railway dashboard → Service → Variables:

| Variable                 | Value                            | Notes                                                          |
| ------------------------ | -------------------------------- | -------------------------------------------------------------- |
| `OPENCLAW_GATEWAY_PORT`  | `18789`                          | Port the gateway listens on                                    |
| `OPENCLAW_GATEWAY_BIND`  | `lan`                            | Bind to all interfaces                                         |
| `OPENCLAW_GATEWAY_TOKEN` | `<random secret>`                | Admin token — generate with `openssl rand -hex 32`             |
| `OPENCLAW_STATE_DIR`     | `/home/node/.openclaw`           | Persistent state directory                                     |
| `OPENCLAW_WORKSPACE_DIR` | `/home/node/.openclaw/workspace` | Agent workspace directory                                      |
| `PORT`                   | `18789`                          | Must match `OPENCLAW_GATEWAY_PORT` for Railway healthcheck     |
| `RAILWAY_RUN_UID`        | `0`                              | Runs container as root so entrypoint can write to the volume   |
| `CISCO_LLM_API_KEY`      | `<Cisco LLM proxy key>`          | Referenced as `${CISCO_LLM_API_KEY}` in `config/openclaw.json` |

### Accessing the Control UI

```
https://<your-railway-domain>/openclaw
```

Enter the `OPENCLAW_GATEWAY_TOKEN` when prompted. Device pairing is disabled via `gateway.controlUi.dangerouslyDisableDeviceAuth: true` in `config/openclaw.json` — token auth alone is sufficient.

### Verifying the deployment

```bash
curl -fsS https://<your-railway-domain>/healthz
```

## Configuration notes

**LLM provider** — Cisco's LLM proxy (`llm-proxy.dev.outshift.ai`) is configured as a custom `openai-completions` provider. The API key is injected at runtime from `CISCO_LLM_API_KEY`.

**Device auth** — `dangerouslyDisableDeviceAuth: true` disables the Control UI device pairing requirement. Safe here as the gateway is protected by token auth and `allowedOrigins` is locked to the Railway domain.

**Trusted proxies** — Railway routes traffic through internal `100.64.x.x` addresses. These are listed in `trustedProxies` in `config/openclaw.json`. If connection issues arise, check Railway logs for the current proxy IP and update accordingly.

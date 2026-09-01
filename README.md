# Real-Time Agent Collaboration

A human-agent collaboration framework built on [OpenClaw](https://openclaw.ai), developed in partnership with Cisco. The system embeds AI agents as active participants in a software engineering team's shared Webex workspace, exploring how an agent can contribute to the work as it emerges without disrupting the human collaborative flow.

## What the system does

The deliverable is an OpenClaw plugin, `plugins/webex`, that observes a team's Webex spaces and turns the discussion in them into tracked work.

A message arrives as a webhook and joins its thread's batch. A first model call, the tagging gate, judges whether the message addresses the system and whether the batch is ready. When it flushes, the pipeline extracts tasks linked to the messages that evidence them, writes a summary to a per-space recall index, decides whether a claimed task needs an approval card, and composes a reply when the message was addressed to the system. Work with no apparent owner is claimed for the development swarm, with the strength of the claim recorded as a band and compared against the space's proactivity threshold.

Teammates review the result in two places: interactive cards posted into the Webex conversation, and a per-space web interface carrying a review queue and a kanban board. All state is written as human-readable JSON on the gateway's own volume.

Architecture notes and diagrams are in `docs/`, principally `docs/collab-agent-architecture-v3.md`.

## Repo structure

```
real-time-agent-collab/
├── config/
│   ├── openclaw.json          # versioned gateway config, source of truth
│   └── workspace/             # workspace scaffolding
├── docs/                      # architecture notes and design docs
├── plugins/
│   └── webex/                 # the collaboration plugin
│       ├── agent-identity/    # AGENTS.md/SOUL.md for the plugin's own agent
│       ├── board/             # React + Vite review queue and kanban board
│       ├── card/              # Webex Adaptive Card builders
│       ├── config/            # per-space configuration card and store
│       ├── embeddings/        # embedding client for recall
│       ├── eval/              # scenario runner, scorers, calibration tooling
│       ├── flow/              # per-message flow orchestration and locking
│       ├── inbound/           # webhook filtering and message handling
│       ├── processing/        # gate, extract, summarize, respond, usage
│       ├── recall/            # per-space recall index
│       ├── storage/           # task and state persistence
│       ├── task-card/         # approval card posting
│       ├── test/              # 375 tests, Node's built-in runner
│       ├── visibility/        # HTTP routes serving the board and space views
│       └── webhook/           # Webex webhook receiver and HMAC verification
├── secrets/                   # gitignored, local only, do not commit
├── openclaw.Dockerfile        # extends the official OpenClaw image
├── docker-entrypoint.sh       # syncs config into the volume, starts the gateway
├── package.json               # repo root manifest
└── railway.toml               # Railway build and deploy config
```

## Development

**Tests.** 375 tests across 85 suites, using Node's built-in test runner. Quote the glob so Node expands it, since the files are `.cjs`:

```bash
node --test "plugins/webex/test/*.test.cjs"
```

**Board.** The review queue and board are a React app built with Vite, served by the gateway from `plugins/webex/board/dist`:

```bash
cd plugins/webex/board && npm install && npm run build
```

**Evaluation.** The scenario runner needs a live plugin runtime, so it is exposed as a gateway RPC method and driven from inside the deployment. It cannot run as a standalone script:

```bash
node openclaw.mjs gateway call webex.eval.run \
  --params '{"scenarioId":"eval-s01-release-readiness"}' \
  --timeout 1800000 --json
```

Bundles are always written to disk under `eval/outputs/<id>/<variant>/<runId>/`, so a client-side timeout means fetching `bundle.json` over ssh instead of losing the run. Scoring is offline and runs anywhere:

```bash
node plugins/webex/eval/score/run.js <bundle.json | bundle-dir> [--no-judge]
```

The judge needs `EVAL_JUDGE_BASE_URL` and `EVAL_JUDGE_API_KEY` in the local environment, with `EVAL_JUDGE_MODEL` optional. Without them the deterministic scorers still run and the judge sections report as unjudged, so a scorecard is always produced. These are local variables and are not set on Railway.

## Deployment

The gateway runs on Railway as the `collab-agent` service in the project of the same name, built from `openclaw.Dockerfile`.

The image extends the official OpenClaw image and copies `config/openclaw.json` and `plugins/` into `/app`. There is no install step: every `require` in the plugin is either a `node:` builtin or a relative path. `docker-entrypoint.sh` copies the versioned config into the mounted volume on every start, because a volume masks files baked into the image layer. The plugin itself is not copied to the volume: `plugins.load.paths` resolves against `/app`, so the gateway loads it straight from the image.

### One-time Railway setup

**1. Volume.** Attach a volume to the `collab-agent` service, mounted at:

```
/home/node/.openclaw
```

This holds both the OpenClaw state directory and the plugin's workspace root at `/home/node/.openclaw/workspace`. Session, delivery-queue and restart state live in SQLite at `state/openclaw.sqlite`, not in flat JSON files. Gateway config is not persisted here, since it is overwritten from `config/openclaw.json` on every start.

**2. Public networking.** Service, then Settings, then Networking, then Generate Domain. Required for the Control UI and for Webex webhooks. The current domain is baked into `config/openclaw.json` in `controlUi.allowedOrigins` and in the two Webex webhook URLs, so changing it means editing the config too.

**3. Environment variables.** Set in the Railway dashboard under Service, then Variables. Railway injects its own `RAILWAY_*` variables automatically and they do not need setting.

Gateway runtime, on `collab-agent`:

| Variable | Value | Notes |
| --- | --- | --- |
| `OPENCLAW_GATEWAY_PORT` | `18789` | Port the gateway listens on |
| `OPENCLAW_GATEWAY_BIND` | `lan` | Bind to all interfaces |
| `OPENCLAW_GATEWAY_TOKEN` | generated | Admin token, `openssl rand -hex 32` |
| `OPENCLAW_STATE_DIR` | `/home/node/.openclaw` | Persistent state directory |
| `OPENCLAW_WORKSPACE_DIR` | `/home/node/.openclaw/workspace` | Agent workspace directory |
| `PORT` | `18789` | Must match `OPENCLAW_GATEWAY_PORT` for the healthcheck |
| `RAILWAY_RUN_UID` | `0` | Runs as root so the entrypoint can write to the volume |

Model provider, on `collab-agent`:

| Variable | Notes |
| --- | --- |
| `CISCO_LLM_API_KEY` | Cisco LLM proxy key, referenced from `config/openclaw.json` |

Webex, on `collab-agent`. The system uses both Webex integration paths: the bot identity sends messages and receives card submissions, and the OAuth identity observes inbound messages.

| Variable | Notes |
| --- | --- |
| `WEBEX_BOT_TOKEN` | Bot access token, outbound messages and cards |
| `WEBEX_ACCESS_TOKEN` | OAuth access token, receives all space messages |
| `WEBEX_REFRESH_TOKEN` | OAuth refresh token, renews the access token |
| `WEBEX_CLIENT_ID` | Webex Integration client ID |
| `WEBEX_CLIENT_SECRET` | Webex Integration client secret |
| `WEBEX_WEBHOOK_SECRET` | HMAC-SHA1 secret for verifying webhook signatures |

**Set but unused.** Nine variables on the service are read by no code or config in this repo and can be removed from Railway unless something outside this repo depends on them:

| Variable | Why it is dead |
| --- | --- |
| `GITHUB_APP_ID` | GitHub App access, which the plugin never uses |
| `GITHUB_APP_PRIVATE_KEY` | As above |
| `GITHUB_WEBHOOK_SECRET` | As above |
| `OPENCLAW_WEBHOOK_SECRET` | The `hooks` block it fed has been removed from the config |
| `WEBEX_EVAL_ROUTES_ENABLED` | Left over from the eval HTTP route, replaced by `webex.eval.run` |
| `WEBEX_EVAL_SECRET` | As above |
| `LANGFUSE_BASE_URL` | Tracing that was never wired up |
| `LANGFUSE_PUBLIC_KEY` | As above |
| `LANGFUSE_SECRET_KEY` | As above |

### Accessing the Control UI

```
https://<railway-domain>/openclaw
```

Enter the `OPENCLAW_GATEWAY_TOKEN` when prompted.

### Verifying the deployment

```bash
curl -fsS https://<railway-domain>/healthz
```

## Configuration notes

**The base image is pinned by digest, not by `latest`.** A rebuild on 2026-09-01 pulled a newer OpenClaw whose config schema had dropped `agents.*.memorySearch` and `cron.maxConcurrentRuns`, both of which `config/openclaw.json` still uses, and the gateway refused to start. Unpin only alongside a deliberate config migration.

**Two agents are configured.** `main` is the host's default agent and is bound to the Webex channel. `collab-agent` is the plugin's own identity, pointed at `plugins/webex/agent-identity` with `contextInjection: never` and a minimal tool profile, so that every pipeline spawn stays isolated from whatever the host's own agent instructions say. The plugin is told which to use through `plugins.entries.webex.config.collabAgentId`.

**Tools.** The plugin registers `submit_gate_decision`, `write_task`, `search_tasks`, `write_summary` and `search_recall`. A test asserts that `contracts.tools` in `openclaw.plugin.json` matches what `index.js` actually registers, since the two drifted apart before.

**HTTP routes.** The plugin serves `/webhooks/webex/` for inbound webhooks, `/webex/collab/board` for the board, and `/webex/collab/` for the per-space views.

**LLM provider.** Cisco's proxy at `llm-proxy.dev.outshift.ai` is configured as a custom `openai-completions` provider. Claude Haiku 4.5 is the default model for every agent; Claude Sonnet 4.6, GPT-5.4 and Gemini 3 Pro are also declared. Recall embeddings resolve from each agent's `memorySearch` block and fail soft when it is absent.

**Device auth.** `dangerouslyDisableDeviceAuth: true` disables Control UI device pairing. Acceptable here because the gateway is behind token auth and `allowedOrigins` is locked to the Railway domain.

**Trusted proxies.** Railway routes traffic through internal `100.64.x.x` addresses, listed in `trustedProxies` in `config/openclaw.json`. If connections start failing, check the Railway logs for the current proxy IP and add it.

**Railway ssh** is the way into the running container for inspecting state. Connections to `ssh.railway.com` are intermittently flaky, so retry a few times before concluding something is broken. There is no `sqlite3` binary in the container; query the state database with Node's built-in `node:sqlite` module.

# Architecture Diagram

## System Overview

```
+-----------------------------------------------------------------------------------+
|                              RAILWAY (Cloud Platform)                             |
|                                                                                   |
|  +-------------------------------------+   +----------------------------------+  |
|  |     OpenClaw Gateway Service        |   |       Setup-UI Service           |  |
|  |     (openclaw.Dockerfile)           |   |       (services/setup-ui/)       |  |
|  |                                     |   |                                  |  |
|  |  +-------------------------------+  |   |  +----------------------------+  |  |
|  |  |      OpenClaw Runtime         |  |   |  |     Express Server        |  |  |
|  |  |      (node openclaw.mjs)      |  |   |  |     (server.js)           |  |  |
|  |  |                               |  |   |  |                            |  |  |
|  |  |  +---------+  +----------+   |  |   |  |  GET  /setup               |  |  |
|  |  |  |  Agent  |  |  Hooks   |   |  |   |  |  POST /api/setup           |  |  |
|  |  |  | "main"  |  | Pipeline |   |  |   |  |  GET  /api/spaces/:id      |  |  |
|  |  |  +---------+  +----------+   |  |   |  |  POST /webhooks/github     |  |  |
|  |  |       |             ^        |  |   |  +----------------------------+  |  |
|  |  |       v             |        |  |   |         |              |         |  |
|  |  |  +---------+  +----------+   |  |   |  +------+------+  +---+------+  |  |
|  |  |  | Skills  |  | POST     |   |  |   |  | React SPA   |  |  Local   |  |  |
|  |  |  | AGENTS  |  | /hooks   |   |  |   |  | (Vite)      |  |  Cache   |  |  |
|  |  |  | SOUL    |  |          |   |  |   |  | Onboarding  |  | /data/   |  |  |
|  |  |  +---------+  +----------+   |  |   |  | Form        |  +----------+  |  |
|  |  +-------------------------------+  |   |  +-------------+               |  |
|  |         |                   ^       |   |                                  |  |
|  |  +------+-------------------+----+  |   +----------------------------------+  |
|  |  |     Plugins                   |  |                                         |
|  |  |                               |  |                                         |
|  |  |  +-------------------------+  |  |                                         |
|  |  |  |   Webex Channel Plugin  |  |  |                                         |
|  |  |  |   (plugins/webex/)      |  |  |                                         |
|  |  |  |                         |  |  |                                         |
|  |  |  | webhook.js  HMAC verify |  |  |                                         |
|  |  |  | inbound.js  DM/space    |  |  |                                         |
|  |  |  |             policy      |  |  |                                         |
|  |  |  | channel.js  send/recv   |  |  |                                         |
|  |  |  | token.js    OAuth mgmt  |  |  |                                         |
|  |  |  +-------------------------+  |  |                                         |
|  |  +-------------------------------+  |                                         |
|  |                                     |                                         |
|  |  Volume: /home/node/.openclaw       |   Volume: /data                         |
|  |  (sessions, workspace, config)      |   (by-space/, by-repo/ cache)           |
|  +-------------------------------------+   +----------------------------------+  |
+-----------------------------------------------------------------------------------+
```

## Message Flow

```
+-------------------+        +---------------------+        +--------------------+
|                   |  HTTP  |                     |        |                    |
|   Webex Cloud     +------->+  Webex Plugin       +------->+  OpenClaw Agent    |
|                   | POST   |  (webhook.js)       | Dispatch  ("main")         |
|  User sends a     |        |                     |        |                    |
|  message in a     |        |  1. HMAC verify     |        |  Receives context: |
|  Webex space      |        |  2. Self-msg filter |        |  Body, RoomId,     |
|                   |        |  3. DM policy check |        |  IsMentioned,      |
|                   |        |  4. Space policy    |        |  ChatType, etc.    |
|                   |        |  5. Membership check|        |                    |
|                   |        |  6. Fetch full msg  |        |  Uses AGENTS.md    |
|                   |        |                     |        |  + SOUL.md for     |
|                   |<-------+  Send response back |<-------+  behaviour rules   |
|                   | POST   |  via Webex API      | Reply  |                    |
|   User sees       | /msg   |                     |        |                    |
|   bot response    |        |                     |        |                    |
+-------------------+        +---------------------+        +--------------------+
```

## Webhook & Hooks Pipeline (collab-sync)

```
+------------+       +----------------+       +----------------+       +----------+
|            | push  |                | POST  |                | POST  |          |
|   GitHub   +------>+ Setup-UI       +------>+ OpenClaw       +------>+  Agent   |
|   Repo     |       | /webhooks/     |       | /hooks         |       |  "main"  |
|            |       |  github        |       |                |       |          |
| .collab/   |       |                |       | Session key:   |       | Parses   |
| files      |       | 1. HMAC verify |       | hook:collab-   |       | JSON     |
| changed    |       | 2. Filter for  |       |   sync         |       | payload  |
|            |       |    .collab/    |       |                |       |          |
|            |       | 3. Read local  |       |                |       | Executes |
|            |       |    cache       |       |                |       | instruct |
|            |       | 4. Build sync  |       |                |       | -ions    |
|            |       |    message     |       |                |       |          |
+------------+       +----------------+       +----------------+       +----------+
```

## Project Onboarding Flow

```
+----------+      +-----------+      +----------------+      +------------+
|          |      |           |      |                |      |            |
|  Agent   +----->+  Webex    +----->+  User clicks   +----->+ Setup-UI   |
|          | send |  Space    |      |  setup link    |      | /setup     |
| Detects  | link |           |      |                |      |            |
| no space |      | User sees |      | Browser opens  |      | React form |
| config   |      | setup URL |      | onboarding     |      | collects:  |
|          |      |           |      | form           |      | - project  |
+----------+      +-----------+      +----------------+      | - repos    |
                                                              | - members  |
                                                              +-----+------+
                                                                    |
                                           +------------------------+
                                           |  POST /api/setup
                                           v
                               +-----------+-----------+
                               |                       |
                               |  1. Write .collab/    |
                               |     files to GitHub   |
                               |                       |
                               |  2. Cache config in   |
                               |     /data/by-space/   |
                               |     /data/by-repo/    |
                               |                       |
                               +-----------------------+
```

## External Services & Integrations

```
+---------------------------+         +---------------------------+
|      Webex Cloud          |         |      GitHub               |
|                           |         |                           |
|  - Bot account            |         |  - GitHub App (JWT auth)  |
|  - OAuth integration      |         |  - Installation tokens    |
|  - Webhook delivery       |         |  - .collab/ file storage  |
|  - Message read/write API |         |  - Webhook push events    |
|  - Space membership API   |         |  - REST API (v3)          |
+------------+--------------+         +------------+--------------+
             |                                     |
             |  HTTPS                              |  HTTPS
             v                                     v
+------------------------------- Railway ----------------------------+
|                                                                    |
|   Gateway Service                    Setup-UI Service              |
|   :18789                             :3000                         |
|                                                                    |
|   Inbound:                           Inbound:                      |
|     /webhooks/webex/*                  /webhooks/github             |
|     /hooks                             /api/setup                  |
|     /healthz                           /setup                      |
|                                        /health                     |
|                                                                    |
|   Internal comms:                                                  |
|     setup-ui ---POST /hooks/agent---> gateway                      |
|     (Railway internal DNS)                                         |
|                                                                    |
+--------------------------------------------------------------------+
             |
             |  HTTPS
             v
+---------------------------+
|   Cisco LLM Proxy         |
|   llm-proxy.dev.outshift  |
|                           |
|   Models available:       |
|   - Claude Sonnet 4.6     |
|   - Claude Haiku 4.5      |
|   - GPT-5.4               |
|   - Gemini 3 Pro Preview  |
+---------------------------+
```

## Inbound Message Filter Chain

```
Webhook POST arrives
        |
        v
+-------+--------+
| Is it a message |--- No ---> DROP (ignore non-message events)
| creation event? |
+-------+--------+
        | Yes
        v
+-------+--------+
| Sent by the bot |--- Yes --> DROP (prevent feedback loops)
| itself?         |
+-------+--------+
        | No
        v
+-------+--------+
| Is it a direct  |--- Yes --> Check dmPolicy:
| message (DM)?   |             allow      -> PASS
+-------+--------+             deny       -> DROP
        |                       allowlisted -> check allowFrom list
        | No (group space)
        v
+-------+---------+
| Space policy    |
| check           |--- Blocked --> DROP + log
| (spacePolicy)   |
+-------+---------+
        | Allowed
        v
+-------+---------+
| Bot is a member |--- No ---> DROP (bot not in this space)
| of this space?  |
+-------+---------+
        | Yes
        v
   PROCESS MESSAGE
   Fetch full text, build context, dispatch to agent
```

## File Structure

```
real-time-agent-collab/
|
+-- config/
|   +-- openclaw.json              # Gateway config (source of truth)
|   +-- workspace/
|       +-- AGENTS.md              # Agent operating instructions
|       +-- SOUL.md                # Agent personality & boundaries
|
+-- plugins/
|   +-- webex/                     # Webex channel plugin
|       +-- index.js               #   Plugin entry + registration
|       +-- channel.js             #   Main plugin object (~850 lines)
|       +-- webhook.js             #   HTTP router, HMAC verification
|       +-- inbound.js             #   Message filtering, dispatch
|       +-- send.js                #   Outbound message builder
|       +-- token.js               #   OAuth token management
|       +-- api.js                 #   Webex REST API wrapper
|       +-- openclaw.plugin.json   #   Plugin config schema
|       +-- package.json           #   @openclaw/webex metadata
|
+-- lib/
|   +-- github.js                  # GitHub App integration (JWT, tokens,
|   |                              #   file CRUD, commits, diffs, PRs)
|   +-- github-test.js             # Manual test script
|   +-- package.json               # @collab/github workspace package
|
+-- services/
|   +-- setup-ui/
|       +-- server.js              # Express server (routes, webhooks)
|       +-- railway.toml           # Railway build/deploy config
|       +-- client/
|           +-- App.jsx            # React onboarding form
|           +-- index.html         # SPA entry point
|           +-- main.jsx           # React bootstrap
|           +-- App.css            # Styling
|
+-- openclaw.Dockerfile            # Gateway Docker image
+-- docker-entrypoint.sh           # Config sync on container start
+-- railway.toml                   # Gateway Railway config
+-- package.json                   # Monorepo root (npm workspaces)
```

## Environment Variables

```
+-------------------------------+--------------------------------------------------+
| Variable                      | Purpose                                          |
+-------------------------------+--------------------------------------------------+
| GATEWAY SERVICE                                                                  |
+-------------------------------+--------------------------------------------------+
| OPENCLAW_GATEWAY_PORT         | Gateway listen port (18789)                      |
| OPENCLAW_GATEWAY_BIND         | Bind address (lan = all interfaces)              |
| OPENCLAW_GATEWAY_TOKEN        | Auth token for control UI + /hooks               |
| OPENCLAW_STATE_DIR            | Persistent state (/home/node/.openclaw)          |
| OPENCLAW_WORKSPACE_DIR        | Agent workspace files                            |
| OPENCLAW_WEBHOOK_SECRET       | Bearer token for /hooks authentication           |
| RAILWAY_RUN_UID               | 0 (root, required for volume writes)             |
| CISCO_LLM_API_KEY             | Cisco LLM proxy API key                          |
| WEBEX_BOT_TOKEN               | Bot account token (sending, webhooks)            |
| WEBEX_ACCESS_TOKEN            | OAuth access token (reading messages)            |
| WEBEX_REFRESH_TOKEN           | OAuth refresh token (renewed every ~12 days)     |
| WEBEX_CLIENT_ID               | OAuth app client ID                              |
| WEBEX_CLIENT_SECRET           | OAuth app client secret                          |
| WEBEX_WEBHOOK_SECRET          | HMAC secret for webhook signature verification   |
+-------------------------------+--------------------------------------------------+
| SETUP-UI SERVICE                                                                 |
+-------------------------------+--------------------------------------------------+
| PORT                          | Express listen port (assigned by Railway)         |
| DATA_DIR                      | Local cache volume (/data)                       |
| GITHUB_APP_ID                 | GitHub App ID for JWT signing                    |
| GITHUB_APP_PRIVATE_KEY        | GitHub App RSA private key                       |
| GITHUB_APP_NAME               | GitHub App slug (for install URLs)               |
| GITHUB_WEBHOOK_SECRET         | HMAC secret for GitHub push webhooks             |
| OPENCLAW_WEBHOOK_SECRET       | Bearer token for posting to gateway /hooks       |
| OPENCLAW_INTERNAL_URL         | Gateway internal URL (Railway service DNS)       |
| WEBEX_BOT_TOKEN               | For space/room lookups during setup              |
+-------------------------------+--------------------------------------------------+
```

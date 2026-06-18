# setup-ui

Project onboarding web app for the Real-Time Agent Collaboration system.

## What it does

When a user is added to a Webex space with the collaboration bot, the bot sends them a setup link:

```
https://<setup-ui-domain>/setup?spaceId=<webex-room-id>
```

The user fills in a form to configure the project (name, repos, team members, GitHub authorisation). On submit, the service writes a `config.json` into the OpenClaw workspace so the agent can look it up on future messages.

## Environment variables

| Variable | Description | Default |
|---|---|---|
| `GITHUB_APP_NAME` | GitHub App slug used to build the installation URL | — |
| `OPENCLAW_WORKSPACE_DIR` | Path to the OpenClaw workspace root | `/home/node/.openclaw/workspace` |
| `PORT` | HTTP port (assigned by Railway) | `3000` |

## Routes

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Railway healthcheck — returns `{ ok: true }` |
| `GET` | `/setup` | Serves the React setup form |
| `GET` | `/api/config` | Returns `{ appName }` for the client |
| `POST` | `/api/setup` | Receives form submission, writes workspace files |
| `GET` | `/api/spaces/:spaceId` | Returns parsed `config.json` for a space, or 404 |

## Workspace layout written on setup

```
<OPENCLAW_WORKSPACE_DIR>/spaces/<spaceId>/.collab/
├── config.json
├── context.md
├── open-questions.md
└── issues.md
```

## Running locally

```bash
npm install
GITHUB_APP_NAME=my-app OPENCLAW_WORKSPACE_DIR=/tmp/workspace npm start
```

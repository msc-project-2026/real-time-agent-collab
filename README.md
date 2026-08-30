# Real-Time Agent Collaboration

Real-Time Agent Collaboration runs an [OpenClaw](https://github.com/openclaw/openclaw) agent as a Webex teammate. It receives Webex messages, can inspect public websites through a browser tool, and can join Webex space meetings in a real browser. The meeting integration can listen without publishing media, optionally transcribe and intervene during a meeting, and write post-meeting minutes to the mapped GitHub repository.

This repository is designed for a public HTTPS deployment on a VPS. Docker Compose runs all application services; Caddy is the only public entry point and obtains/renews TLS certificates automatically.

## What is included

```text
Internet
   |
   v
Caddy (:80, :443, automatic HTTPS)
   |-- /setup*, /api/* -----------------> setup-ui (:3000)
   `-- /healthz, /hooks, /webhooks/* --> OpenClaw (:18789)
                                            |-- Webex channel plugin
                                            |-- Webex meeting auto-join plugin
                                            |-- Browser Inspector plugin
                                            `-- Cisco LLM proxy
```

The main components are:

- `plugins/webex/` — Webex messaging channel. The bot sends replies; an OAuth-authorized human account observes messages and maintains the Webex subscriptions.
- `plugins/webex-meeting-join/` — a self-contained meeting participant. It owns its meeting and message webhooks and uses the real Webex Browser SDK in headless Brave/Chromium.
- `plugins/browser-inspector/` — agent tools to inspect public pages, check resources and links, capture a screenshot to a Webex space, and save browser-discovered issues or suggested fixes to the mapped repository.
- `services/setup-ui/` — React/Express onboarding UI at `/setup?spaceId=<webex-room-id>`. It writes a project's `.collab/` files using a GitHub App.
- `lib/` — GitHub App authentication and repository helper functions.

## Meeting plugin

The meeting plugin is intentionally separate from the Webex chat plugin, because a Webex bot cannot join meetings. It needs two identities:

| Identity | Used for | Credential |
|---|---|---|
| Webex bot | Send agent and meeting replies; receive attachment-action webhooks | `WEBEX_BOT_TOKEN` |
| Dedicated normal Webex user | Join meetings, read room messages without an @mention, own meeting/transcript webhooks | OAuth access, refresh, client ID, and client secret |

At gateway start the plugin registers these subscriptions under the normal user account:

- `meetings/started` and `meetings/ended`
- `messages/created`
- `meetingTranscripts/created` when minutes are enabled and the OAuth grant permits it

When a meeting starts, the plugin resolves the meeting, verifies that the meeting user is in the room, and launches the Webex Browser SDK in a headless browser. Brave is installed by the gateway image because the SDK needs H.264 support, even for its audio-only media negotiation. It joins with receive-only audio: it does not publish a microphone, camera, or screen share.

Meeting controls in the Webex room include:

- `/meeting join` or an addressed “join the meeting” request — join the current meeting once.
- `/meeting leave` or “leave meeting” — leave and suppress rejoining that meeting instance.
- `/meeting enable` or “you can join meetings” — enable durable auto-join for the room.
- “never join meetings” — disable durable auto-join for the room and leave an active meeting.

Preferences are stored in the persistent OpenClaw workspace. Startup reconciliation and a five-minute poll catch meetings whose start webhook was missed.

After a meeting, Webex's completed VTT/TXT transcript is summarized into **Summary**, **Decisions**, **Action Items**, and **Open Questions**, then appended idempotently to `.collab/meeting minutes.md` in the project's primary GitHub repository. A bounded retry job survives gateway restarts if the transcript webhook is delayed or missed.

Set `DEEPGRAM_API_KEY` only if live transcription and proactive interventions are wanted. Without it, the plugin still joins, listens, responds to commands, and produces Webex-transcript-based minutes; no meeting audio is sent to Deepgram.

## Browser Inspector plugin

The Browser Inspector gives the Webex agent four practical browser capabilities:

- inspect a public page for console errors, failed resources, broken internal links, headings, forms, and accessibility basics;
- inspect a selected element's content, attributes, visibility, and bounding box;
- take a viewport or full-page screenshot and upload it directly to a Webex space;
- record an issue or a proposed source change in the space's mapped GitHub project.

The inspector accepts only `http` and `https` URLs and rejects localhost, private IP ranges, and hostnames that resolve to private addresses. Browser contexts close after each action and the shared browser is closed after five minutes idle.

## Prerequisites

- A Linux VPS with at least 2 GB RAM and a public IPv4 address. Ubuntu 22.04 or 24.04 is a good baseline.
- A hostname such as `agent.example.com`, with a public DNS **A** record pointing to the VPS. Webex webhooks and Let's Encrypt require a real HTTPS hostname; a bare IP address is not sufficient.
- Inbound TCP ports 80 and 443 open at both the cloud-provider firewall and the server firewall.
- An SSH key and a Git repository URL for this project.
- A Webex developer account, a Webex bot, and a dedicated normal user account that may join the target spaces and meetings.
- A Cisco LLM proxy key (or a deliberate change to `config/openclaw.json` to use another model provider).
- A GitHub App for onboarding and/or a fine-grained GitHub token for meeting minutes.

## Configure a new VPS

The following commands use Ubuntu and `/opt/real-time-agent-collab`. Replace the repository URL and hostname with your own values.

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl git ufw

# Install Docker Engine and its Compose plugin.
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker "$USER"

# Log out/in once so the docker group is effective, then verify it.
docker compose version

# Leave SSH enabled, then expose only HTTP(S).
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable

sudo install -d -o "$USER" -g "$USER" /opt/real-time-agent-collab
git clone <REPOSITORY-URL> /opt/real-time-agent-collab
cd /opt/real-time-agent-collab
```

Before the first launch, verify DNS from a machine outside the VPS:

```bash
dig +short agent.example.com
```

It must return the VPS public IP. Do this before Caddy starts so HTTP-01 certificate validation can succeed.

## Create the deployment secrets

Never commit `.env` or `secrets/github-app-private-key.pem`.

```bash
cd /opt/real-time-agent-collab
cp .env.example .env
mkdir -p secrets
chmod 700 secrets
```

Create long random values for the gateway, internal hooks, and Webex webhook HMAC:

```bash
openssl rand -hex 32  # OPENCLAW_GATEWAY_TOKEN
openssl rand -hex 32  # OPENCLAW_WEBHOOK_SECRET
openssl rand -hex 32  # WEBEX_WEBHOOK_SECRET
openssl rand -hex 32  # GITHUB_WEBHOOK_SECRET, if GitHub push sync is enabled
```

Edit `.env` and set the hostname-related values first:

```dotenv
DOMAIN=agent.example.com
ACME_EMAIL=ops@example.com
CONTROL_UI_ORIGIN=https://agent.example.com

OPENCLAW_GATEWAY_TOKEN=<generated value>
OPENCLAW_WEBHOOK_SECRET=<generated value>
CISCO_LLM_API_KEY=<Cisco proxy key>

# Required by setup-ui for GitHub push synchronisation. These are consumed by
# services/setup-ui/server.js even though older copies of .env.example omit them.
GITHUB_WEBHOOK_SECRET=<generated value>
OPENCLAW_INTERNAL_URL=http://openclaw:18789
DATA_DIR=/data
```

`OPENCLAW_INTERNAL_URL` must be the Compose service address, not the public URL: setup-ui uses it to send trusted `/hooks/agent` requests across the private Docker network.

Paste the complete private key downloaded from the GitHub App settings into `secrets/github-app-private-key.pem`, including the `BEGIN`/`END` lines, then restrict it:

```bash
nano secrets/github-app-private-key.pem
chmod 600 secrets/github-app-private-key.pem
```

## Webex setup and tokens

### 1. Create the Webex bot

In the Webex developer portal, create a bot, give it an appropriate display name, and copy its bot access token into:

```dotenv
WEBEX_BOT_TOKEN=<bot access token>
```

Add the bot to every space where it should communicate. The bot is the visible identity for chat replies, screenshots, and meeting interventions. It is **not** the account that joins a meeting.

### 2. Create and authorize a Webex Integration for the meeting user

Create a Webex **Integration** for a dedicated, normal Webex user. Register a redirect URI you control when creating the integration. The repository does not host an OAuth callback; its access and refresh tokens are obtained during this one-time authorization and placed in `.env`.

Request at least these scopes:

- `spark:all` — required by the Webex Browser SDK/Locus flow for meeting join and leave. Granular meeting REST scopes alone are insufficient for this plugin's SDK session.
- `meeting:schedules_read` — allows scheduled-meeting lookup and transcript recovery.
- `meeting:transcripts_read` — required for the transcript webhook and post-meeting minutes.

Use the Integration's client ID, redirect URI, and scopes to open an authorization URL similar to this (URL-encode the redirect URI in real use):

```text
https://webexapis.com/v1/authorize?client_id=<CLIENT_ID>&response_type=code&redirect_uri=<REDIRECT_URI>&scope=spark%3Aall%20meeting%3Aschedules_read%20meeting%3Atranscripts_read
```

Sign in as the dedicated meeting user, approve the request, and exchange the returned authorization code. For example:

```bash
curl --user '<CLIENT_ID>:<CLIENT_SECRET>' \
  --request POST 'https://webexapis.com/v1/access_token' \
  --header 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode 'grant_type=authorization_code' \
  --data-urlencode 'code=<AUTHORIZATION_CODE>' \
  --data-urlencode 'redirect_uri=<REDIRECT_URI>'
```

Store the response values as follows:

```dotenv
# Main Webex chat channel OAuth identity. It may be the same dedicated user.
WEBEX_ACCESS_TOKEN=<access_token>
WEBEX_REFRESH_TOKEN=<refresh_token>
WEBEX_CLIENT_ID=<Integration client ID>
WEBEX_CLIENT_SECRET=<Integration client secret>

# The plugin falls back to the four values above. Set these only when the
# meeting participant must be a different normal user.
# WEBEX_MEETING_ACCESS_TOKEN=<meeting account access token>
# WEBEX_MEETING_REFRESH_TOKEN=<meeting account refresh token>
# WEBEX_MEETING_CLIENT_ID=<meeting Integration client ID>
# WEBEX_MEETING_CLIENT_SECRET=<meeting Integration client secret>
```

The access token alone starts the plugin, but the refresh token, client ID, and client secret are strongly recommended. The process refreshes its OAuth identity at startup, every 12 days, and once after a Webex 401. If scopes change, repeat the authorization-code flow: refreshing an old grant does not add scopes.

The dedicated meeting user must be a member of every Webex space it should monitor and must have permission to join that room's meetings. Transcript visibility is controlled by Webex; organization-wide transcript coverage may need Webex administrator or compliance authorization.

### 3. Configure Webex webhooks

Set the public target URLs in `.env` using the same hostname as `DOMAIN`:

```dotenv
WEBEX_WEBHOOK_SECRET=<generated value>
WEBEX_BOT_WEBHOOK_URL=https://agent.example.com/webhooks/webex/bot/default
WEBEX_OAUTH_WEBHOOK_URL=https://agent.example.com/webhooks/webex/oauth/default
WEBEX_MEETING_WEBHOOK_URL=https://agent.example.com/webhooks/webex-meeting-join
```

Do **not** manually create duplicate subscriptions. On every OpenClaw startup the chat plugin registers the bot attachment-action and OAuth message webhooks; the meeting plugin removes stale subscriptions at its target URLs and registers its four own resources. Both verify the Webex `X-Spark-Signature` against `WEBEX_WEBHOOK_SECRET` when it is set.

### 4. Optional live transcription and minutes storage

For live Deepgram transcription and proactive replies, set:

```dotenv
DEEPGRAM_API_KEY=<Deepgram API key>
```

For post-meeting minutes, use either the GitHub App configured below or a fine-grained token with **Contents: read and write** access to each mapped repository:

```dotenv
WEBEX_MEETING_MINUTES_GITHUB_TOKEN=<optional fine-grained GitHub token>
```

Without an onboarding mapping, a single fallback repository can be configured with `COLLAB_GITHUB_OWNER` and `COLLAB_GITHUB_REPO`. In normal operation, use `/setup?spaceId=<room-id>` to create the room-to-repository mapping instead.

## GitHub App and project onboarding

Create a GitHub App with the repository permissions needed to read and write Contents, generate a private key, and install the App on every project repository. Set:

```dotenv
GITHUB_APP_ID=<numeric App ID>
GITHUB_APP_NAME=<App slug>
GITHUB_APP_PRIVATE_KEY_FILE=/run/secrets/github-app-private-key.pem
```

After deployment, visit:

```text
https://agent.example.com/setup?spaceId=<WEBEX_ROOM_ID>
```

Complete the project, repositories, and team-member form, then install/authorize the GitHub App on the primary repository. The UI creates `.collab/config.json`, context, issue, and question files. That configuration lets browser issue tools and meeting minutes resolve the correct GitHub repository.

To enable GitHub push-based `.collab/` synchronisation as well, create a GitHub repository webhook with:

- Payload URL: `https://agent.example.com/webhooks/github`
- Content type: `application/json`
- Secret: the same value as `GITHUB_WEBHOOK_SECRET`
- Event: **Just the push event**

## Production Compose notes

The checked-in Compose/Caddy configuration has three deployment details to address before relying on setup UI persistence or GitHub push sync:

1. `.env.example` sets `PORT=18789`, and Compose passes `.env` to both services. `setup-ui` therefore listens on 18789 while Caddy connects to 3000. Override its port in `docker-compose.yml`.
2. setup-ui writes its cache to `/data`, but that directory is not mounted to a persistent volume. Persist it so room/repository mappings survive a container recreation.
3. Caddy currently routes only `/setup*` and `/api/*` to setup-ui. Add `/webhooks/github` or GitHub will reach OpenClaw instead of setup-ui.

Apply the following once to a deployment branch (or incorporate its equivalent into your infrastructure definition):

```diff
diff --git a/docker-compose.yml b/docker-compose.yml
@@
 volumes:
   openclaw_state:
+  setup_ui_data:
@@
   setup-ui:
     env_file: .env
+    environment:
+      PORT: "3000"
+      OPENCLAW_INTERNAL_URL: ${OPENCLAW_INTERNAL_URL:-http://openclaw:18789}
+      DATA_DIR: /data
     volumes:
       - ./secrets/github-app-private-key.pem:/run/secrets/github-app-private-key.pem:ro
+      - setup_ui_data:/data
diff --git a/Caddyfile b/Caddyfile
@@
-  @setupui path /setup* /api/*
+  @setupui path /setup* /api/* /webhooks/github
```

Also remove or replace the unrelated `code.asabizanjo.dev` site block in `Caddyfile` before using this repository under another domain. It is not part of the collaboration service.

## Launch and verify

Build and start the stack from the repository root:

```bash
docker compose up -d --build
docker compose ps
docker compose logs -f caddy
```

After Caddy has issued the certificate, verify the service externally:

```bash
curl --fail --silent --show-error https://agent.example.com/healthz
```

Then inspect startup logs. They should show the Webex channel, `webex-meeting-join` webhook registration, and the meeting plugin's reconciliation/polling startup:

```bash
docker compose logs --tail=200 openclaw
docker compose logs --tail=100 setup-ui
```

Open `https://agent.example.com/openclaw` and authenticate with `OPENCLAW_GATEWAY_TOKEN`. Do not expose or paste that token into a Webex room.

For an end-to-end test:

1. Add both the bot and the normal meeting user to a test Webex space.
2. Send the bot an ordinary message and confirm it replies.
3. Start an instant Webex meeting in that space; confirm the OpenClaw logs show an SDK join and receive-only audio subscription.
4. Send `/meeting leave`, then `/meeting join`, and verify the control actions in logs.
5. End the meeting, wait for Webex to publish a transcript, and confirm `.collab/meeting minutes.md` is committed to the primary repository.

## Operations

```bash
# Service health and logs
docker compose ps
docker compose logs -f openclaw
docker compose logs -f setup-ui
docker compose logs -f caddy

# Rebuild after a code or configuration change
bash scripts/deploy.sh

# Stop containers without deleting named volumes
docker compose down

# Run the repository test suite
npm test
```

Back up the named state volumes before host migration or destructive Docker maintenance. `openclaw_state` contains the workspace, space preferences, and pending meeting-minute recovery jobs; `caddy_data` contains TLS/ACME state; `setup_ui_data` contains setup UI mappings after the production Compose adjustment above.

## Troubleshooting

| Symptom | Check |
|---|---|
| Caddy cannot obtain a certificate | DNS must already resolve to the VPS and port 80 must be publicly reachable. Inspect `docker compose logs caddy`. |
| Webex messages do not arrive | Confirm the public HTTPS URL, both identities' tokens, Webex space membership, and `WEBEX_WEBHOOK_SECRET`. Inspect `openclaw` logs for webhook registration and inbound routes. |
| Meeting plugin is disabled | It requires `WEBEX_BOT_TOKEN`, a meeting access token (or `WEBEX_ACCESS_TOKEN`), and `WEBEX_MEETING_WEBHOOK_URL`. |
| Meeting join fails after REST calls work | Reauthorize the normal meeting user with `spark:all`; the Browser SDK needs it for Locus join/leave. Confirm Brave is present in the built gateway image. |
| No minutes appear | Ensure the meeting user's OAuth grant includes `meeting:transcripts_read` and `meeting:schedules_read`, transcripts are available to that user, the room has a project mapping, and GitHub write credentials are configured. |
| setup-ui is unreachable or mappings vanish | Apply the Production Compose notes: port 3000 override and a persistent `/data` volume. |
| GitHub push sync returns 404/never fires | Route `/webhooks/github` to setup-ui, configure `GITHUB_WEBHOOK_SECRET`, and use the same secret in GitHub. |
| Browser inspector rejects a URL | This is expected for localhost, private IP addresses, or a hostname resolving to one; use a publicly reachable URL. |

## Repository configuration

`config/openclaw.json` is the versioned gateway source of truth. It is copied into the persistent OpenClaw state directory each time the container starts. Edit it to change the Webex allowlist, agent bindings, models, or plugin enablement, then rebuild/restart the stack. If the Compose network's fixed Caddy address changes, update `gateway.trustedProxies` there to match.

Keep all production secrets out of Git. `.env`, the `secrets/` directory, and PEM files are already ignored.

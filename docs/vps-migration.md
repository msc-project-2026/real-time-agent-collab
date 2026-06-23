# Migrating from Railway to an Ubuntu VPS

This guide walks through moving the Real-Time Agent Collaboration system off
Railway and onto a self-hosted Ubuntu VPS, preserving all functionality
(OpenClaw gateway, Webex integration, setup-ui) and using a `.env` file for
secrets.

## What changes vs. Railway

| Concern             | Railway                                  | VPS                                                        |
| ------------------- | ---------------------------------------- | --------------------------------------------------------- |
| Orchestration       | Railway services (one per `railway.toml`) | `docker-compose.yml` (caddy + openclaw + setup-ui)        |
| TLS / public URL    | Generated `*.up.railway.app` domain      | Your domain + Caddy automatic Let's Encrypt HTTPS         |
| Secrets             | Railway dashboard variables              | `.env` file (gitignored) + mounted GitHub key             |
| Persistent state    | Attached volume `/home/node/.openclaw`   | Docker named volume `openclaw_state`                       |
| Run-as-root hack    | `RAILWAY_RUN_UID=0`                       | `user: "0:0"` in compose                                   |
| Trusted proxies     | Railway `100.64.x.x` IPs                 | Caddy static IP `172.28.0.10`                              |
| Deploy on push      | Railway GitHub integration               | `.github/workflows/deploy.yml` (SSH) or `scripts/deploy.sh` |

The `railway.toml` files have been removed; everything Railway-specific is gone.

---

## 1. Provision the VPS

A small Ubuntu 22.04/24.04 box (1–2 vCPU, 2 GB RAM) is enough to start.

```bash
ssh root@<vps-ip>
adduser deploy && usermod -aG sudo deploy   # optional non-root user
```

Open the firewall for HTTP/HTTPS (and SSH):

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80,443/tcp
sudo ufw enable
```

## 2. Install Docker

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER   # log out/in afterwards so `docker` works sans sudo
docker compose version          # verify the compose plugin is present
```

## 3. Point DNS at the VPS

Create an **A record** for your chosen hostname (e.g. `collab.example.com`)
pointing at the VPS public IP. This is required: Webex webhooks and Let's
Encrypt both need a real, publicly resolvable HTTPS hostname — a bare IP will
not work.

Verify before continuing:

```bash
dig +short collab.example.com   # should print your VPS IP
```

## 4. Clone the repo

```bash
sudo mkdir -p /opt/real-time-agent-collab
sudo chown $USER:$USER /opt/real-time-agent-collab
git clone <repo-url> /opt/real-time-agent-collab
cd /opt/real-time-agent-collab
```

## 5. Configure secrets

```bash
cp .env.example .env
nano .env
```

Fill in every value. Generate the random secrets with:

```bash
openssl rand -hex 32   # for OPENCLAW_GATEWAY_TOKEN, OPENCLAW_WEBHOOK_SECRET, WEBEX_WEBHOOK_SECRET
```

Set the domain-derived values to your hostname:

```
DOMAIN=collab.example.com
ACME_EMAIL=you@example.com
CONTROL_UI_ORIGIN=https://collab.example.com
WEBEX_WEBHOOK_URL=https://collab.example.com/webhooks/webex/default
```

Carry over the Webex and Cisco credentials from the Railway dashboard
(`WEBEX_*`, `CISCO_LLM_API_KEY`).

### GitHub App private key

The PEM is multiline and doesn't fit cleanly in `.env`, so it's mounted as a
file (see `GITHUB_APP_PRIVATE_KEY_FILE` in `.env`):

```bash
mkdir -p secrets
nano secrets/github-app-private-key.pem   # paste the full -----BEGIN ... END----- block
```

`secrets/` is gitignored — it never gets committed.

## 6. First launch

```bash
docker compose up -d --build
docker compose ps
docker compose logs -f caddy      # watch the certificate get issued (~30s)
```

Caddy provisions the TLS certificate automatically on first request. Once it's
ready:

```bash
curl -fsS https://collab.example.com/healthz
```

Open the Control UI at `https://collab.example.com/openclaw` and log in with
`OPENCLAW_GATEWAY_TOKEN`.

## 7. Verify Webex

The gateway re-registers its Webex webhook to `WEBEX_WEBHOOK_URL` on every
start (see `plugins/webex/token.js` → `ensureWebhook`). Confirm it's wired up:

- Send the bot a DM from an allowlisted address (`channels.webex.allowFrom` in
  `config/openclaw.json`) and check `docker compose logs -f openclaw` for
  `[webex] webhookRouter called`.
- If inbound messages don't arrive, the most common cause is the public URL not
  being reachable over HTTPS — re-check DNS, the firewall, and that Caddy got a
  cert.

## 8. Set up auto-deploy on push

This reproduces Railway's deploy-on-push using GitHub Actions.

1. Create an SSH key pair for CI and authorise it on the VPS:

   ```bash
   ssh-keygen -t ed25519 -f deploy_key -N ""
   ssh-copy-id -i deploy_key.pub deploy@<vps-ip>   # or append deploy_key.pub to ~/.ssh/authorized_keys
   ```

2. In the GitHub repo → **Settings → Secrets and variables → Actions**, add:

   | Secret        | Value                                       |
   | ------------- | ------------------------------------------- |
   | `VPS_HOST`    | VPS IP or domain                            |
   | `VPS_USER`    | `deploy`                                     |
   | `VPS_SSH_KEY` | contents of the **private** `deploy_key`    |
   | `DEPLOY_PATH` | `/opt/real-time-agent-collab`               |
   | `VPS_PORT`    | (optional) SSH port if not 22               |

3. Push to `main`. The workflow (`.github/workflows/deploy.yml`) SSHes in,
   `git reset --hard origin/main`, and runs `scripts/deploy.sh`.

Manual deploys remain available any time:

```bash
ssh deploy@<vps-ip>
cd /opt/real-time-agent-collab && git pull && bash scripts/deploy.sh
```

## 9. Decommission Railway

Once the VPS is serving traffic and Webex round-trips work, delete the Railway
services (or pause them first as a fallback). Remove the Railway GitHub
integration so it stops building on push.

---

## Operations cheatsheet

```bash
docker compose ps                 # status
docker compose logs -f openclaw   # gateway logs
docker compose logs -f setup-ui   # onboarding app logs
docker compose restart openclaw   # restart one service
docker compose up -d --build      # rebuild after a code change
docker compose down               # stop everything (state volume is kept)
```

**Backups** — the only stateful piece is the `openclaw_state` volume:

```bash
docker run --rm -v real-time-agent-collab_openclaw_state:/data -v "$PWD":/backup \
  busybox tar czf /backup/openclaw_state.tar.gz -C /data .
```

## Troubleshooting

- **Caddy can't get a cert** — DNS not pointing at the VPS yet, or ports 80/443
  blocked/in use. Check `docker compose logs caddy` and `sudo ss -tlnp | grep -E ':(80|443)'`.
- **Control UI rejects the browser** — `CONTROL_UI_ORIGIN` must exactly equal
  `https://<your-domain>` (no trailing slash).
- **Gateway sees the wrong client IP / proxy errors** — `trustedProxies` in
  `config/openclaw.json` must match Caddy's static IP (`172.28.0.10`). If you
  changed the `collab` network subnet in `docker-compose.yml`, update both.
- **GitHub calls fail** — confirm `secrets/github-app-private-key.pem` exists and
  `GITHUB_APP_ID` is set; check `docker compose logs setup-ui`.

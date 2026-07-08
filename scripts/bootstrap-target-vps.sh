#!/usr/bin/env bash
# Provision the TARGET VPS that hosts deployed apps. Idempotent: safe to re-run.
#
# It installs Docker, nixpacks, and the deploy-cli binary; starts the
# caddy-docker-proxy reverse proxy; creates the /opt/apps layout and the
# registry; and creates a locked-down `deploy` user whose SSH key can ONLY run
# deploy-cli (forced command) — never a shell.
#
# Usage (run as root or with sudo, from a checkout of this repo):
#   ACME_EMAIL=you@example.com \
#   DEPLOY_AGENT_PUBKEY="ssh-ed25519 AAAA... agent" \
#   [DEPLOY_DOMAIN_SUFFIX=1-2-3-4.sslip.io] \
#   bash scripts/bootstrap-target-vps.sh
#
# DEPLOY_DOMAIN_SUFFIX defaults to <public-ip-with-dashes>.sslip.io.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPLOY_USER="deploy"
APPS_DIR="/opt/apps"
ENV_FILE="/etc/deploy-cli.env"
CLI_BIN="/usr/local/bin/deploy-cli"
CLI_FORCED="/usr/local/bin/deploy-cli-forced"

log() { printf '\n==> %s\n' "$*"; }

require_root() {
	if [ "$(id -u)" -ne 0 ]; then
		echo "ERROR: run as root (or with sudo)." >&2
		exit 1
	fi
}

require_vars() {
	: "${ACME_EMAIL:?set ACME_EMAIL}"
	: "${DEPLOY_AGENT_PUBKEY:?set DEPLOY_AGENT_PUBKEY to the agent SSH public key}"
}

detect_suffix() {
	if [ -n "${DEPLOY_DOMAIN_SUFFIX:-}" ]; then
		echo "$DEPLOY_DOMAIN_SUFFIX"
		return
	fi
	local ip
	ip="$(curl -fsS https://api.ipify.org 2>/dev/null || true)"
	if [ -z "$ip" ]; then
		ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
	fi
	if [ -z "$ip" ]; then
		echo "ERROR: could not determine public IP; set DEPLOY_DOMAIN_SUFFIX." >&2
		exit 1
	fi
	echo "${ip//./-}.sslip.io"
}

install_docker() {
	if command -v docker >/dev/null 2>&1; then
		log "Docker already installed ($(docker --version))"
		return
	fi
	log "Installing Docker"
	curl -fsSL https://get.docker.com | sh
	systemctl enable --now docker
}

install_nixpacks() {
	if command -v nixpacks >/dev/null 2>&1; then
		log "nixpacks already installed ($(nixpacks --version))"
		return
	fi
	log "Installing nixpacks"
	curl -fsSL https://nixpacks.com/install.sh | bash
}

build_cli() {
	log "Building deploy-cli (via golang container, no host Go needed)"
	docker run --rm \
		-v "$REPO_ROOT/deploy-cli":/src \
		-w /src \
		-e CGO_ENABLED=0 -e GOOS=linux -e GOARCH="$(dpkg --print-architecture 2>/dev/null | sed 's/arm64/arm64/;s/amd64/amd64/' || echo amd64)" \
		golang:1.26 \
		go build -o /src/deploy-cli .
	install -m 0755 "$REPO_ROOT/deploy-cli/deploy-cli" "$CLI_BIN"
	rm -f "$REPO_ROOT/deploy-cli/deploy-cli"
	log "Installed $CLI_BIN"
}

setup_layout() {
	log "Creating $APPS_DIR layout"
	mkdir -p "$APPS_DIR" "$APPS_DIR/.registry" "$APPS_DIR/.env-store"
	chmod 0750 "$APPS_DIR/.env-store"
}

write_env_file() {
	log "Writing $ENV_FILE (domain suffix: $SUFFIX)"
	cat >"$ENV_FILE" <<EOF
DEPLOY_DOMAIN_SUFFIX=$SUFFIX
DEPLOY_APPS_DIR=$APPS_DIR
DEPLOY_ENV_DIR=$APPS_DIR/.env-store
DEPLOY_REGISTRY_DB=$APPS_DIR/.registry/registry.db
DEPLOY_AUDIT_LOG=$APPS_DIR/.registry/deploy-audit.jsonl
DEPLOY_NETWORK=caddy
DEPLOY_PORT=${DEPLOY_PORT:-3000}
DEPLOY_MEM_MB=${DEPLOY_MEM_MB:-512}
DEPLOY_CPUS=${DEPLOY_CPUS:-0.5}
DEPLOY_RESTART=unless-stopped
DEPLOY_MAX_MEM_PCT=${DEPLOY_MAX_MEM_PCT:-90}
DEPLOY_MAX_DISK_PCT=${DEPLOY_MAX_DISK_PCT:-90}
EOF
	chmod 0644 "$ENV_FILE"
}

write_forced_wrapper() {
	log "Writing forced-command wrapper $CLI_FORCED"
	# The wrapper loads config env then execs deploy-cli. It deliberately does NOT
	# read or interpret SSH_ORIGINAL_COMMAND — deploy-cli tokenizes that itself,
	# with no shell — so a compromised key cannot run anything but deploy-cli.
	cat >"$CLI_FORCED" <<EOF
#!/bin/sh
set -a
. $ENV_FILE
set +a
exec $CLI_BIN
EOF
	chmod 0755 "$CLI_FORCED"
}

setup_deploy_user() {
	if id "$DEPLOY_USER" >/dev/null 2>&1; then
		log "User $DEPLOY_USER already exists"
	else
		log "Creating user $DEPLOY_USER"
		useradd --create-home --shell /usr/sbin/nologin "$DEPLOY_USER"
	fi
	# The CLI needs the Docker socket to launch app containers. The forced-command
	# restriction is what bounds this power to deploy-cli only.
	usermod -aG docker "$DEPLOY_USER"
	# Registry + apps are owned by the deploy user.
	chown -R "$DEPLOY_USER":"$DEPLOY_USER" "$APPS_DIR"
}

install_agent_key() {
	local ssh_dir="/home/$DEPLOY_USER/.ssh"
	local auth="$ssh_dir/authorized_keys"
	mkdir -p "$ssh_dir"
	local opts='command="'"$CLI_FORCED"'",no-agent-forwarding,no-port-forwarding,no-x11-forwarding,no-pty'
	local line="$opts $DEPLOY_AGENT_PUBKEY"
	touch "$auth"
	# Replace any prior line for this key/forced command; keep the file idempotent.
	grep -vF "$CLI_FORCED" "$auth" >"$auth.tmp" 2>/dev/null || true
	mv "$auth.tmp" "$auth"
	echo "$line" >>"$auth"
	chmod 700 "$ssh_dir"
	chmod 600 "$auth"
	chown -R "$DEPLOY_USER":"$DEPLOY_USER" "$ssh_dir"
	log "Installed agent key with forced command"
}

start_proxy() {
	log "Ensuring caddy network + reverse proxy"
	docker network inspect caddy >/dev/null 2>&1 || docker network create caddy
	ACME_EMAIL="$ACME_EMAIL" docker compose -f "$REPO_ROOT/deploy-infra/docker-compose.yml" up -d
}

verify() {
	log "Verifying deploy-cli health"
	sudo -u "$DEPLOY_USER" env $(grep -v '^#' "$ENV_FILE" | xargs) "$CLI_BIN" health || {
		echo "WARN: health check reported an issue (Docker may still be starting)." >&2
	}
}

main() {
	require_root
	require_vars
	SUFFIX="$(detect_suffix)"
	install_docker
	install_nixpacks
	build_cli
	setup_layout
	write_env_file
	write_forced_wrapper
	setup_deploy_user
	install_agent_key
	start_proxy
	verify
	log "Done. Apps will be served at <name>.$SUFFIX"
	log "Add this to the openclaw .env:  DEPLOY_VPS_HOST + DEPLOY_DOMAIN_SUFFIX=$SUFFIX"
}

main "$@"

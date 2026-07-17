#!/bin/sh
# Ensures the repo's versioned openclaw.json is the source of truth.
# Volumes mask image-layer files, so the config must be copied at runtime,
# not just at build time. The container starts as root so it can repair state
# written by older root-running releases, then drops permanently to uid 1000.

set -e

state_dir="${OPENCLAW_STATE_DIR:-/home/node/.openclaw}"
config_path="$state_dir/openclaw.json"
cdp_port="${WEBEX_AUTO_JOIN_CDP_PORT:-18801}"

mkdir -p "$state_dir"
cp /app/config/openclaw.json "$config_path"
chmod 600 "$config_path"

# Chromium leaves Singleton* files behind when the container or browser is
# killed. The supervisor correctly treats a lock with no CDP endpoint as stale,
# but it cannot recover while the files remain. Clear only those exact lock
# names before the gateway starts; preserve them if a live browser still owns
# the configured CDP port.
if ! curl -fsS --max-time 1 "http://127.0.0.1:${cdp_port}/json/version" >/dev/null 2>&1; then
	find "$state_dir" \
		\( -name 'SingletonLock' -o -name 'SingletonSocket' -o -name 'SingletonCookie' \) \
		-exec rm -f -- {} + 2>/dev/null || true
fi

if [ "$(id -u)" -eq 0 ]; then
	# Do not descend into the read-only workspace skills bind mount.
	find "$state_dir" \
		-path "$state_dir/workspace/skills" -prune -o \
		-exec chown -h node:node {} +
	exec gosu node /app/openclaw-supervisor.sh
fi

exec /app/openclaw-supervisor.sh

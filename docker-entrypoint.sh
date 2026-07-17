#!/bin/sh
# Ensures the repo's versioned openclaw.json is the source of truth.
# Volumes mask image-layer files, so the config must be copied at runtime,
# not just at build time. The container starts as root so it can repair state
# written by older root-running releases, then drops permanently to uid 1000.

set -e

state_dir="${OPENCLAW_STATE_DIR:-/home/node/.openclaw}"
config_path="$state_dir/openclaw.json"

mkdir -p "$state_dir"
cp /app/config/openclaw.json "$config_path"
chmod 600 "$config_path"

if [ "$(id -u)" -eq 0 ]; then
	# Do not descend into the read-only workspace skills bind mount.
	find "$state_dir" \
		-path "$state_dir/workspace/skills" -prune -o \
		-exec chown -h node:node {} +
	exec gosu node /app/openclaw-supervisor.sh
fi

exec /app/openclaw-supervisor.sh

#!/bin/sh
# Ensures the repo's versioned openclaw.json is the source of truth.
# Volumes mask image-layer files, so the config must be copied at runtime,
# not just at build time. The container starts as root so it can repair state
# written by older root-running releases, then drops permanently to uid 1000.

set -e

state_dir="${OPENCLAW_STATE_DIR:-/home/node/.openclaw}"
config_path="$state_dir/openclaw.json"
sandbox_workspace_root="${OPENCLAW_SANDBOX_WORKSPACE_ROOT:-}"

mkdir -p "$state_dir"
cp /app/config/openclaw.json "$config_path"
chmod 600 "$config_path"

if [ -n "$sandbox_workspace_root" ]; then
	mkdir -p "$sandbox_workspace_root"
	chown -R node:node "$sandbox_workspace_root"
fi

if [ "$(id -u)" -eq 0 ]; then
	# Do not descend into the read-only workspace skills bind mount.
	find "$state_dir" \
		-path "$state_dir/workspace/skills" -prune -o \
		-exec chown -h node:node {} +
	if [ -S /var/run/docker.sock ]; then
		# Docker's group ID differs between VPS images. Make it the node
		# process's primary group dynamically rather than requiring a value in
		# .env. The process keeps uid=node, which owns the OpenClaw state.
		docker_group="$(stat -c '%g' /var/run/docker.sock)"
		exec gosu "node:${docker_group}" node openclaw.mjs gateway
	fi
	exec gosu node node openclaw.mjs gateway
fi

exec node openclaw.mjs gateway

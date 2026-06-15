#!/bin/sh
# Ensures the repo's versioned openclaw.json is the source of truth.
# Volumes mask image-layer files, so the config must be copied at runtime,
# not just at build time. This runs as CMD (under the base image's tini
# entrypoint), then execs the gateway so tini remains PID 1.
set -e

mkdir -p /home/node/.openclaw
cp /app/config/openclaw.json /home/node/.openclaw/openclaw.json

exec node openclaw.mjs gateway
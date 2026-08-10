#!/bin/sh
# Ensures the repo's versioned openclaw.json is the source of truth.
# Volumes mask image-layer files, so the config must be copied at runtime,
# not just at build time. Container runs as root (RAILWAY_RUN_UID=0), so no
# permission issues writing to the mounted volume.

set -e

# Copy openclaw config
mkdir -p /home/node/.openclaw
cp /app/config/openclaw.json /home/node/.openclaw/openclaw.json

# Copy openclaw workspace
mkdir -p /home/node/.openclaw/workspace
cp -r /app/config/workspace/. /home/node/.openclaw/workspace/

if [ -z "$SETUP_UI_PUBLIC_URL" ]; then
  echo "SETUP_UI_PUBLIC_URL is required" >&2
  exit 1
fi

sed -i \
  "s|__SETUP_UI_PUBLIC_URL__|${SETUP_UI_PUBLIC_URL%/}|g" \
  /home/node/.openclaw/workspace/AGENTS.md

exec node openclaw.mjs gateway

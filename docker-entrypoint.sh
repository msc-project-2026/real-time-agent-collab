# !/bin/sh
# Ensures the repo's versioned openclaw.json is the source of truth.
# Volumes mask image-layer files, so the config must be copied at runtime,
# not just at build time. Container runs as root (RAILWAY_RUN_UID=0), so no
# permission issues writing to the mounted volume.

set -e

# Copy openclaw config
mkdir -p /home/node/.openclaw
cp /app/config/openclaw.json /home/node/.openclaw/openclaw.json

# Copy openclaw workspace
mkdir -p /home/node/.openclaw/workspace
cp -r /app/config/workspace/. /home/node/.openclaw/workspace/

exec node openclaw.mjs gateway
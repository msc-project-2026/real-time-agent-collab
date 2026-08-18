# !/bin/sh
# Ensures the repo's versioned openclaw.json and build-time-installed
# plugins are the source of truth. Volumes mask image-layer files, so both
# must be synced at runtime, not just copied at build time. Container runs
# as root (RAILWAY_RUN_UID=0), so no permission issues writing to the
# mounted volume.
#
# Workspace files are deliberately left alone: they belong to whatever
# already exists in the mounted volume for this instance.

set -e

# Copy openclaw config
mkdir -p /home/node/.openclaw
cp /app/config/openclaw.json /home/node/.openclaw/openclaw.json

# Sync build-time installed plugins (see HOME=/app RUN step in Dockerfile)
mkdir -p /home/node/.openclaw/plugins
cp -r /app/.openclaw/plugins/. /home/node/.openclaw/plugins/

exec node openclaw.mjs gateway
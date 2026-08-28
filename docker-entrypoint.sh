# !/bin/sh
# Ensures the repo's versioned openclaw.json is the source of truth. Volumes
# mask image-layer files, so it must be synced at runtime, not just copied at
# build time. Container runs as root (RAILWAY_RUN_UID=0), so no permission
# issues writing to the mounted volume.
#
# Workspace files are deliberately left alone: they belong to whatever
# already exists in the mounted volume for this instance.
#
# The webex plugin is NOT copied to the volume. plugins.load.paths
# ("plugins/webex") resolves against the working directory (/app), so the
# gateway loads it straight from the image layer — verified on the deployment
# with the volume copy moved aside: `plugins list` still reported
# /app/plugins/webex/index.js and `devices list` still validated config.
# The copy this script used to make was for a plugin that is no longer used,
# and because `cp -r src dst` copies *into* an existing dst, every redeploy
# after the first nested another stale copy inside the last.

set -e

# Copy openclaw config
mkdir -p /home/node/.openclaw
cp /app/config/openclaw.json /home/node/.openclaw/openclaw.json

exec node openclaw.mjs gateway
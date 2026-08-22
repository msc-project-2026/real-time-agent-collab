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

# Sync the webex plugin. plugins.load.paths in openclaw.json ("plugins/webex")
# resolves relative to the OpenClaw state dir (/home/node/.openclaw), not /app
# where the image actually puts it — without this copy, the gateway fails with
# "plugin path not found: /home/node/.openclaw/plugins/webex", which also
# blocks config validation for unrelated commands (e.g. `openclaw devices list`).
mkdir -p /home/node/.openclaw/plugins
cp -r /app/plugins/webex /home/node/.openclaw/plugins/webex

exec node openclaw.mjs gateway
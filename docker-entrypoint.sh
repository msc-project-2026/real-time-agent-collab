# !/bin/sh
# Ensures the repo's versioned openclaw.json is the source of truth.
# Volumes mask image-layer files, so the config must be copied at runtime,
# not just at build time. Container runs as root (compose `user: "0:0"`), so
# there are no permission issues writing to the mounted volume.

set -e

mkdir -p /home/node/.openclaw
cp /app/config/openclaw.json /home/node/.openclaw/openclaw.json

exec node openclaw.mjs gateway
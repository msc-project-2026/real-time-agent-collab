# Extends the official OpenClaw gateway image.
# Base: node:24-bookworm-slim, runs as non-root user `node` (uid 1000).
# Base ENTRYPOINT is ["tini", "-s", "--"]; kept as-is for signal handling.
FROM ghcr.io/openclaw/openclaw:latest

# Versioned config is the source of truth. Copied into /app/config at build
# time, then synced into the mounted volume at container start (volumes mask
# image-layer files, so build-time COPY alone isn't enough).
# Workspace (AGENTS.md/SOUL.md) is intentionally NOT copied here — that's
# host-instance config, and this plugin shouldn't override it.
COPY --chown=node:node config/openclaw.json /app/config/openclaw.json

# Install third-party plugins at build time, into a staging home dir under
# /app so the installed files land in the image layer instead of the
# eventual Railway-mounted volume at /home/node/.openclaw (which would
# otherwise mask them, same issue as config above). Synced into the volume
# by docker-entrypoint.sh at container start.
RUN OPENCLAW_STATE_DIR=/app/.openclaw-build openclaw plugins install clawhub:openclaw-x-langfuse-plugin && find /app/.openclaw-build -maxdepth 3

COPY --chown=node:node docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh

# Note: the Railway volume at /home/node/.openclaw is mounted as root, while
# the base image's default user is node (uid 1000). Set RAILWAY_RUN_UID=0 in
# the Railway service variables so the container runs as root and can write
# to the mounted volume.

# Copy shared lib and update plugins/ ownership.
# npm install --workspaces creates the @collab/* symlinks in node_modules
# so plugins can import shared packages (e.g. @collab/github) at runtime.
COPY --chown=root:root plugins/ /app/plugins/
COPY --chown=root:root lib/ /app/lib/
COPY --chown=root:root package.json /app/package.json
RUN npm install --workspaces --ignore-scripts

# Overrides the base CMD only; ENTRYPOINT (tini) is inherited.
CMD ["/app/docker-entrypoint.sh"]

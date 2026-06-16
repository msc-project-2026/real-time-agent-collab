# Extends the official OpenClaw gateway image.
# Base: node:24-bookworm-slim, runs as non-root user `node` (uid 1000).
# Base ENTRYPOINT is ["tini", "-s", "--"]
# Kept as-is so tini remains PID 1 for signal handling.
FROM ghcr.io/openclaw/openclaw:latest

# Versioned config is the source of truth. Copied into /app/config at build
# time, then synced into the mounted volume at container start (volumes mask
# image-layer files, so build-time COPY alone isn't enough).
COPY --chown=node:node config/openclaw.json /app/config/openclaw.json
COPY --chown=node:node docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh

# Note: the Railway volume at /home/node/.openclaw is mounted as root, while
# the base image's default user is node (uid 1000). Set RAILWAY_RUN_UID=0 in
# the Railway service variables so the container runs as root and can write
# to the mounted volume.

# Install webex plugin
USER root
RUN npm install @jimiford/webex

# Overrides the base CMD only; ENTRYPOINT (tini) is inherited.
CMD ["/app/docker-entrypoint.sh"]
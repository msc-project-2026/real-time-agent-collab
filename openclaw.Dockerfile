# Extends the official OpenClaw gateway image.
# Base: node:24-bookworm-slim, runs as non-root user `node` (uid 1000).
# Base ENTRYPOINT is ["tini", "-s", "--"]
# Kept as-is so tini remains PID 1 for signal handling.
FROM ghcr.io/openclaw/openclaw:latest

# Versioned config is the source of truth. Copied into /app/config at build
# time, then synced into the mounted volume at container start (volumes mask
# image-layer files, so build-time COPY alone isn't enough).
COPY --chown=node:node config/openclaw.json /app/config/openclaw.json
COPY --chown=node:node config/workspace/ /app/config/workspace/

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

# The official OpenClaw image defaults to USER node, but npm needs to create
# workspace node_modules and TypeScript dist output in the root-owned paths.
USER root

RUN npm install --workspaces --include=dev --ignore-scripts \
    && npm run build --workspace github-plugin \
    && npm run plugin:validate --workspace github-plugin \
    && npm prune --workspaces --omit=dev --ignore-scripts

# Preserve the base image's safe default. Railway overrides this at runtime
# with RAILWAY_RUN_UID=0 because the mounted volume is root-owned.
USER node

# Overrides the base CMD only; ENTRYPOINT (tini) is inherited.
CMD ["/app/docker-entrypoint.sh"]

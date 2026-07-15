# Extends the official OpenClaw gateway image.
# Base: node:24-bookworm-slim, runs as non-root user `node` (uid 1000).
# Base ENTRYPOINT is ["tini", "-s", "--"]
# Kept as-is so tini remains PID 1 for signal handling.
# Pin the tested browser-control contract. Renovate this digest deliberately
# alongside the meeting-join contract tests instead of inheriting API changes
# from a mutable latest-browser tag during an unrelated rebuild.
FROM ghcr.io/openclaw/openclaw:latest-browser@sha256:d4f53c02f77c9e8d67c2ecd009cf1b32e165596829405a3d723dae039c46cb90

# Versioned config is the source of truth. Copied into /app/config at build
# time, then synced into the mounted volume at container start (volumes mask
# image-layer files, so build-time COPY alone isn't enough).
COPY --chown=node:node config/openclaw.json /app/config/openclaw.json
COPY --chown=node:node docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh

# Note: the named volume at /home/node/.openclaw needs to be writable at
# runtime. docker-compose runs this service as root (`user: "0:0"`) so the
# entrypoint can sync config and the gateway can persist state.

# Keep the workspace owned by the base image's non-root `node` user so npm can
# create workspace-local node_modules during the image build.
# npm install --workspaces creates the @collab/* symlinks in node_modules
# so plugins can import shared packages (e.g. @collab/github) at runtime.
COPY --chown=node:node plugins/ /app/plugins/
COPY --chown=node:node lib/ /app/lib/
COPY --chown=node:node package.json package-lock.json /app/
RUN npm install --workspaces --include=dev --ignore-scripts \
	&& npm run build --workspace=@openclaw/meeting-join

# Overrides the base CMD only; ENTRYPOINT (tini) is inherited.
CMD ["/app/docker-entrypoint.sh"]

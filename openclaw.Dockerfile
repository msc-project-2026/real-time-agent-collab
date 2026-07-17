# Extends the official OpenClaw gateway image.
# Base: node:24-bookworm-slim, with tini as PID 1 and `node` (uid 1000) as
# the normal runtime user.
#
# Pin the browser-enabled OpenClaw image so general browser access remains
# available in the gateway.
ARG OPENCLAW_IMAGE=ghcr.io/openclaw/openclaw:latest-browser@sha256:d4f53c02f77c9e8d67c2ecd009cf1b32e165596829405a3d723dae039c46cb90

FROM ${OPENCLAW_IMAGE}

# Compose starts as root only so the entrypoint can migrate ownership of an
# existing named volume. gosu drops permanently to uid 1000 before OpenClaw
# starts, keeping plugin ownership checks and the gateway runtime non-root.
USER root
RUN apt-get update \
	&& apt-get install -y --no-install-recommends gosu \
	&& rm -rf /var/lib/apt/lists/*

# Versioned config is the source of truth. It is synced into the mounted state
# volume by the entrypoint because volumes mask image-layer files.
COPY --chown=node:node config/openclaw.json /app/config/openclaw.json
COPY --chown=node:node docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod 755 /app/docker-entrypoint.sh

# Copy the custom plugins without touching OpenClaw's own package manifest or
# dependency tree.
COPY --chown=node:node plugins/ /app/plugins/
COPY --chown=node:node lib/ /app/lib/

# source-observer imports @collab/github as a package. Install that small local
# package under the plugin tree so Node can resolve it without modifying
# /app/node_modules (which is owned by the upstream OpenClaw image).
COPY --chown=node:node lib/ /app/plugins/source-observer/node_modules/@collab/github/

# Overrides the base CMD only; ENTRYPOINT (tini) is inherited.
CMD ["/app/docker-entrypoint.sh"]

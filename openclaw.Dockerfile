# Extends the official OpenClaw gateway image.
# Base: node:24-bookworm-slim, with tini as PID 1 and `node` (uid 1000) as
# the normal runtime user.
#
# Pin the tested browser-control contract. Renovate this digest deliberately
# alongside the webex-auto-join contract tests instead of inheriting API changes
# from a mutable latest-browser tag during an unrelated rebuild.
ARG OPENCLAW_IMAGE=ghcr.io/openclaw/openclaw:latest-browser@sha256:d4f53c02f77c9e8d67c2ecd009cf1b32e165596829405a3d723dae039c46cb90

# Build custom plugin assets away from /app. The official image's package.json
# and node_modules belong to OpenClaw; running npm in /app replaces that package
# graph and can prune required OpenClaw modules.
FROM ${OPENCLAW_IMAGE} AS plugin-build

USER root
RUN install -d -o node -g node /tmp/collab-build
USER node
WORKDIR /tmp/collab-build
COPY --chown=node:node package.json package-lock.json ./
COPY --chown=node:node lib/package.json ./lib/package.json
COPY --chown=node:node plugins/source-observer/package.json ./plugins/source-observer/package.json
COPY --chown=node:node plugins/webex-auto-join/package.json ./plugins/webex-auto-join/package.json
COPY --chown=node:node services/setup-ui/package.json ./services/setup-ui/package.json
RUN npm ci --workspaces --include=dev --ignore-scripts

COPY --chown=node:node plugins/webex-auto-join/ ./plugins/webex-auto-join/
RUN npm run build --workspace=@openclaw/webex-auto-join

FROM ${OPENCLAW_IMAGE}

# Compose starts as root only so the entrypoint can migrate ownership of an
# existing named volume. gosu drops permanently to uid 1000 before OpenClaw
# starts, keeping plugin ownership checks and the gateway runtime non-root.
USER root
RUN apt-get update \
	&& apt-get install -y --no-install-recommends gosu \
	&& rm -rf /var/lib/apt/lists/*

# The meeting runner needs a browser carrying the proprietary H264 codec. The Webex
# SDK hardcodes requireH264 when negotiating a transcoded media connection and then
# validates its own local SDP, so it rejects addMedia outright on the image's bundled
# Chromium — before any audio can flow, and even for an audio-only receiver. Brave is
# Chromium-based, ships the codec, and unlike Google Chrome publishes arm64 Linux
# builds. Only the webex-auto-join browser profile points at it (see
# browser.profiles in config/openclaw.json); everything else keeps the default.
RUN apt-get update \
	&& apt-get install -y --no-install-recommends curl ca-certificates \
	&& curl -fsSLo /usr/share/keyrings/brave-browser-archive-keyring.gpg \
		https://brave-browser-apt-release.s3.brave.com/brave-browser-archive-keyring.gpg \
	&& echo "deb [signed-by=/usr/share/keyrings/brave-browser-archive-keyring.gpg arch=$(dpkg --print-architecture)] https://brave-browser-apt-release.s3.brave.com/ stable main" \
		> /etc/apt/sources.list.d/brave-browser-release.list \
	&& apt-get update \
	&& apt-get install -y --no-install-recommends brave-browser \
	&& rm -rf /var/lib/apt/lists/*

# Versioned config is the source of truth. It is synced into the mounted state
# volume by the entrypoint because volumes mask image-layer files.
COPY --chown=node:node config/openclaw.json /app/config/openclaw.json
COPY --chown=node:node docker-entrypoint.sh /app/docker-entrypoint.sh
COPY --chown=node:node openclaw-supervisor.sh /app/openclaw-supervisor.sh
RUN chmod 755 /app/docker-entrypoint.sh /app/openclaw-supervisor.sh

# Copy the custom plugins without touching OpenClaw's own package manifest or
# dependency tree. webex-auto-join is replaced with the asset built above.
COPY --chown=node:node plugins/ /app/plugins/
COPY --from=plugin-build --chown=node:node /tmp/collab-build/plugins/webex-auto-join/dist/ /app/plugins/webex-auto-join/dist/
COPY --chown=node:node lib/ /app/lib/

# source-observer imports @collab/github as a package. Install that small local
# package under the plugin tree so Node can resolve it without modifying
# /app/node_modules (which is owned by the upstream OpenClaw image).
COPY --chown=node:node lib/ /app/plugins/source-observer/node_modules/@collab/github/

# Overrides the base CMD only; ENTRYPOINT (tini) is inherited.
CMD ["/app/docker-entrypoint.sh"]

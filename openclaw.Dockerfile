# Extends the official OpenClaw gateway image.
# Base: node:24-bookworm-slim, with tini as PID 1 and `node` (uid 1000) as
# the normal runtime user.
#
# Pin the browser-enabled OpenClaw image; this image also installs Brave below
# for OpenClaw's gateway-managed browser session.
ARG OPENCLAW_IMAGE=ghcr.io/openclaw/openclaw:latest-browser@sha256:d4f53c02f77c9e8d67c2ecd009cf1b32e165596829405a3d723dae039c46cb90

FROM ${OPENCLAW_IMAGE}

# Compose starts as root only so the entrypoint can migrate ownership of an
# existing named volume. gosu drops permanently to uid 1000 before OpenClaw
# starts, keeping plugin ownership checks and the gateway runtime non-root.
USER root
RUN apt-get update \
	&& apt-get install -y --no-install-recommends ca-certificates curl gosu \
	&& curl -fsSLo /usr/share/keyrings/brave-browser-archive-keyring.gpg \
		https://brave-browser-apt-release.s3.brave.com/brave-browser-archive-keyring.gpg \
	&& echo "deb [signed-by=/usr/share/keyrings/brave-browser-archive-keyring.gpg arch=$(dpkg --print-architecture)] https://brave-browser-apt-release.s3.brave.com/ stable main" \
		> /etc/apt/sources.list.d/brave-browser-release.list \
	&& apt-get update \
	&& apt-get install -y --no-install-recommends brave-browser \
	&& rm -rf /var/lib/apt/lists/*

# Brave runs inside this gateway container under OpenClaw's managed `openclaw`
# profile. It does not require the Docker daemon or an OpenClaw sandbox.

# Versioned config is the source of truth. It is synced into the mounted state
# volume by the entrypoint because volumes mask image-layer files.
COPY --chown=node:node config/openclaw.json /app/config/openclaw.json
COPY --chown=node:node config/workspace/ /app/config/workspace/

COPY --chown=node:node docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod 755 /app/docker-entrypoint.sh

# Manifests first (better layer caching): a source-only change to plugins/lib
# won't invalidate the npm ci layer below.
COPY --chown=node:node package.json package-lock.json /app/
COPY --chown=node:node lib/package.json /app/lib/package.json
COPY --chown=node:node plugins/source-observer/package.json /app/plugins/source-observer/package.json
COPY --chown=node:node plugins/webex-meeting-join/package.json /app/plugins/webex-meeting-join/package.json

# npm ci installs straight from the lockfile (no dependency resolution, unlike
# npm install) so plugins can resolve @collab/* imports at runtime, without
# touching OpenClaw's own package manifest or dependency tree.
RUN npm ci --workspaces --ignore-scripts --no-audit --no-fund

# Now the actual plugin/lib source.
COPY --chown=node:node plugins/ /app/plugins/
COPY --chown=node:node lib/ /app/lib/

# Install Playwright's Chromium binary and its required system libraries.
# The base image (node:24-bookworm-slim) lacks these dependencies.
ENV PLAYWRIGHT_BROWSERS_PATH=/app/.cache/ms-playwright
RUN npx playwright install --with-deps chromium

# Overrides the base CMD only; ENTRYPOINT (tini) is inherited.
CMD ["/app/docker-entrypoint.sh"]

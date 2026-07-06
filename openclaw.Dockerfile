# Extends the official OpenClaw gateway image.
# Base: node:24-bookworm-slim, runs as non-root user `node` (uid 1000).
# Base ENTRYPOINT is ["tini", "-s", "--"]
# Kept as-is so tini remains PID 1 for signal handling.
FROM ghcr.io/openclaw/openclaw:latest

# Puppeteer (used by the Webex plugin's meeting-join feature) normally
# auto-downloads its own bundled Chromium via an npm postinstall script.
# --ignore-scripts below skips that, so Chromium is installed from Debian's
# own package repo instead and puppeteer is pointed at it directly. This
# also pulls in the shared libraries Chromium needs to run headless (nss,
# gbm, alsa, fonts, etc.) as ordinary apt dependencies.
USER root
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium \
    && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# Versioned config is the source of truth. Copied into /app/config at build
# time, then synced into the mounted volume at container start (volumes mask
# image-layer files, so build-time COPY alone isn't enough).
COPY --chown=node:node config/openclaw.json /app/config/openclaw.json
COPY --chown=node:node docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh

# Note: the named volume at /home/node/.openclaw needs to be writable at
# runtime. docker-compose runs this service as root (`user: "0:0"`) so the
# entrypoint can sync config and the gateway can persist state.

# Copy shared lib and update plugins/ ownership.
# npm install --workspaces creates the @collab/* symlinks in node_modules
# so plugins can import shared packages (e.g. @collab/github) at runtime.
COPY --chown=root:root plugins/ /app/plugins/
COPY --chown=root:root lib/ /app/lib/
COPY --chown=root:root package.json /app/package.json 
RUN npm install --workspaces --ignore-scripts

# Build the meeting-client bundle (esbuild) that meetingRuntime.js's headless
# page loads. Runs after npm install so the webex plugin's devDependencies
# (esbuild) are present. If your workspace layout builds each plugin
# separately, adjust the --workspace path below to match.
RUN npm run build:meeting-client --workspace=plugins/webex

# Overrides the base CMD only; ENTRYPOINT (tini) is inherited.
CMD ["/app/docker-entrypoint.sh"]

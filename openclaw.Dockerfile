# Extends the official OpenClaw gateway image.
# Base: node:24-bookworm-slim, runs as non-root user `node` (uid 1000).
# Base ENTRYPOINT is ["tini", "-s", "--"]
# Kept as-is so tini remains PID 1 for signal handling.
FROM ghcr.io/openclaw/openclaw:latest

# The Webex plugin's meeting-join feature uses Playwright's Chromium, not
# Puppeteer's — Puppeteer bundles "Chrome for Testing", which has no official
# Linux ARM64 build at all (https://pptr.dev/guides/system-requirements).
# Playwright maintains its own separately-built Chromium with confirmed
# Debian 12 Bookworm arm64 support, which is what makes this actually work
# on an ARM VPS.
#
# Playwright's own installer (`playwright install --with-deps`) downloads
# the browser AND installs the exact OS packages it needs via apt — more
# reliable than us guessing at a generic `apt-get install chromium` package,
# which is what the earlier Puppeteer-based approach did.
#
# This needs root (apt access) and needs to run AFTER npm install (below),
# since the `playwright` package must already be in node_modules for its own
# CLI to exist.
USER root

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

# Download Playwright's Chromium build + its required OS packages for this
# workspace. Downloads to root's cache (/root/.cache/ms-playwright by
# default) — fine here since the container runs as root at runtime too
# (see docker-compose.yml's `user: "0:0"`), so chromium.launch() in
# meetingRuntime.js finds it without needing an explicit executablePath.
RUN cd plugins/webex && npx playwright install --with-deps chromium

# Build the meeting-client bundle (esbuild) that meetingRuntime.js's headless
# page loads. If your workspace layout builds each plugin separately, adjust
# the --workspace path below to match.
RUN npm run build:meeting-client --workspace=plugins/webex

# Overrides the base CMD only; ENTRYPOINT (tini) is inherited.
CMD ["/app/docker-entrypoint.sh"]

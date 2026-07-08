# Extends the official OpenClaw gateway image.
# Base: node:24-bookworm-slim, runs as non-root user `node` (uid 1000).
# Base ENTRYPOINT is ["tini", "-s", "--"]
# Kept as-is so tini remains PID 1 for signal handling.
FROM ghcr.io/openclaw/openclaw:latest

# The deploy-agent plugin reaches the hosting VPS over SSH (it shells out to the
# `ssh` client), which the slim base image does not ship. Install it here.
USER root
RUN apt-get update \
	&& apt-get install -y --no-install-recommends openssh-client \
	&& rm -rf /var/lib/apt/lists/*

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

# Overrides the base CMD only; ENTRYPOINT (tini) is inherited.
CMD ["/app/docker-entrypoint.sh"]

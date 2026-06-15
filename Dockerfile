# Extends the official OpenClaw gateway image.
# Base: node:24-bookworm-slim, runs as non-root user `node` (uid 1000).
FROM ghcr.io/openclaw/openclaw:latest

# Config and workspace are expected under /home/node/.openclaw (mounted volume on Railway).
# No custom config yet (minimal starting point).

# Default command is inherited from the base image (starts the gateway).
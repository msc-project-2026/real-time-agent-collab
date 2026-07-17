# OpenClaw launches this image as an isolated per-agent browser sandbox.
# This is self-contained rather than based on a locally pre-built
# `openclaw-sandbox-browser` image. Brave's official Linux repository publishes
# arm64 packages, so the install follows the architecture of the VPS image.
FROM debian:bookworm-slim

USER root

RUN apt-get update \
	&& apt-get install -y --no-install-recommends ca-certificates curl python3 \
	&& curl -fsSLo /usr/share/keyrings/brave-browser-archive-keyring.gpg \
		https://brave-browser-apt-release.s3.brave.com/brave-browser-archive-keyring.gpg \
	&& echo "deb [signed-by=/usr/share/keyrings/brave-browser-archive-keyring.gpg arch=$(dpkg --print-architecture)] https://brave-browser-apt-release.s3.brave.com/ stable main" \
		> /etc/apt/sources.list.d/brave-browser-release.list \
	&& apt-get update \
	&& apt-get install -y --no-install-recommends brave-browser \
	&& rm -rf /var/lib/apt/lists/*

COPY --chmod=755 scripts/sandbox-brave-browser-entrypoint.sh /usr/local/bin/openclaw-sandbox-browser

RUN useradd --create-home --shell /bin/bash sandbox
USER sandbox
WORKDIR /home/sandbox

EXPOSE 9222
CMD ["openclaw-sandbox-browser"]

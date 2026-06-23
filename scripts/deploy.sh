#!/usr/bin/env bash
# Rebuild and (re)start the stack from the current checkout.
# Run on the VPS after pulling new code, or invoked by the GitHub Actions
# deploy workflow. Assumes docker-compose.yml + .env exist in the repo root.
set -euo pipefail

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ ! -f .env ]; then
	echo "ERROR: .env not found. Copy .env.example to .env and fill it in." >&2
	exit 1
fi

echo "==> Building and starting containers"
docker compose up -d --build

echo "==> Pruning dangling images"
docker image prune -f

echo "==> Current status"
docker compose ps

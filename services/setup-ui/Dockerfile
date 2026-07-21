# Build context is the REPO ROOT (see docker-compose.yml) so the workspace
# symlink @collab/github (from lib/) can be resolved at install time.
FROM node:24-bookworm-slim

WORKDIR /app

# Workspace manifests first, for better caching -- npm ci installs straight
# from the lockfile (no dependency resolution, unlike npm install).
COPY package.json package-lock.json ./
COPY lib/package.json ./lib/package.json
COPY services/setup-ui/package.json ./services/setup-ui/package.json

# Installs both the `lib` and `services/setup-ui` workspaces, creating the
# node_modules/@collab/github symlink the server imports at runtime.
RUN npm ci --workspaces --ignore-scripts --no-audit --no-fund

# Now the actual source, last so it doesn't invalidate the install layer.
COPY lib/ ./lib/
COPY services/setup-ui/ ./services/setup-ui/

# Vite build -> services/setup-ui/dist (served statically by server.js).
RUN npm run build --workspace=services/setup-ui

ENV PORT=3000
EXPOSE 3000

CMD ["node", "services/setup-ui/server.js"]

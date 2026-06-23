# Build context is the REPO ROOT (see docker-compose.yml) so the workspace
# symlink @collab/github (from lib/) can be resolved at install time.
FROM node:24-bookworm-slim

WORKDIR /app

# Workspace manifests + shared lib first, then the service, for better caching.
COPY package.json ./
COPY lib/ ./lib/
COPY services/setup-ui/ ./services/setup-ui/

# Installs both the `lib` and `services/setup-ui` workspaces, creating the
# node_modules/@collab/github symlink the server imports at runtime.
RUN npm install --workspaces --ignore-scripts

# Vite build -> services/setup-ui/dist (served statically by server.js).
RUN npm run build --workspace=services/setup-ui

ENV PORT=3000
EXPOSE 3000

CMD ["node", "services/setup-ui/server.js"]

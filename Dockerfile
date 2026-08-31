# Single app image: UI + API + WebSocket + WebMCP registration bundle.
FROM node:26-alpine AS base
# Node >= 25 ships without corepack; install pnpm directly (pinned major).
RUN npm install -g pnpm@11
WORKDIR /repo

FROM base AS deps
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/contracts/package.json packages/contracts/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
ARG BUILD_ID=unknown
ENV BUILD_ID=$BUILD_ID
RUN pnpm --filter @webmcp-hackathon/web build

FROM build AS runtime
# NODE_ENV decides the serving mode (compose overrides it for development,
# where the server runs Vite middleware for HMR over the watch-synced sources).
ENV NODE_ENV=production
EXPOSE 4173
CMD ["node", "apps/server/src/server.ts"]

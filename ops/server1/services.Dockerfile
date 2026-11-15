# Orrery services (API, indexer, prober, keeper) for server 1. Build context: orrery/services.
#   docker build -f ../ops/server1/services.Dockerfile -t orrery-services:<commit> .
FROM node:24-alpine
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json tsconfig.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/sdk/package.json packages/sdk/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
RUN pnpm install --frozen-lockfile --filter @orrery/server... --filter orrery-services
COPY packages/shared packages/shared
COPY packages/sdk packages/sdk
COPY packages/server packages/server
# The release switch's only writer runs inside the api container:
#   docker exec orrery-api /app/node_modules/.bin/tsx /app/scripts/releases.ts list
COPY scripts/releases.ts scripts/releases.ts
USER node
WORKDIR /app/packages/server
# The service is picked per container: api, indexer, prober or keeper (src/bin/<name>.ts).
ENTRYPOINT ["/app/node_modules/.bin/tsx"]
CMD ["src/bin/api.ts"]

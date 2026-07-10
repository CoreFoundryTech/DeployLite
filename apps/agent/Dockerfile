FROM node:22.14.0-alpine3.21 AS build
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/agent ./apps/agent
COPY packages/config ./packages/config
COPY packages/contracts ./packages/contracts
COPY packages/domain ./packages/domain
RUN corepack enable && pnpm install --frozen-lockfile && pnpm --filter @deploylite/config --filter @deploylite/contracts --filter @deploylite/domain --filter @deploylite/agent build

FROM node:22.14.0-alpine3.21
WORKDIR /app
# Alpine 3.21 repository packages provide Git plus the Docker CLI and Compose
# v2 plugin required by the executor. Keep this image on Alpine 3.21 until a
# deliberate tool-version refresh; Docker socket access remains privileged.
RUN apk add --no-cache git docker-cli docker-cli-compose
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/agent/package.json ./apps/agent/package.json
COPY --from=build /app/apps/agent/node_modules ./apps/agent/node_modules
COPY --from=build /app/apps/agent/dist ./apps/agent/dist
COPY --from=build /app/packages/config/package.json ./packages/config/package.json
COPY --from=build /app/packages/config/node_modules ./packages/config/node_modules
COPY --from=build /app/packages/config/dist ./packages/config/dist
COPY --from=build /app/packages/contracts/package.json ./packages/contracts/package.json
COPY --from=build /app/packages/contracts/node_modules ./packages/contracts/node_modules
COPY --from=build /app/packages/contracts/dist ./packages/contracts/dist
COPY --from=build /app/packages/domain/package.json ./packages/domain/package.json
COPY --from=build /app/packages/domain/node_modules ./packages/domain/node_modules
COPY --from=build /app/packages/domain/dist ./packages/domain/dist
CMD ["node", "apps/agent/dist/main.js"]

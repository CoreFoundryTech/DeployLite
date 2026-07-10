FROM node:22-alpine AS build
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/agent ./apps/agent
COPY packages/config ./packages/config
COPY packages/contracts ./packages/contracts
RUN corepack enable && pnpm install --frozen-lockfile && pnpm --filter @deploylite/config --filter @deploylite/contracts --filter @deploylite/agent build

FROM node:22-alpine
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/agent/dist ./apps/agent/dist
COPY --from=build /app/packages/config ./packages/config
COPY --from=build /app/packages/contracts ./packages/contracts
CMD ["node", "apps/agent/dist/index.js"]

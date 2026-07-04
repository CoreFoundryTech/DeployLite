# syntax=docker/dockerfile:1.7

FROM node:22-alpine AS build
WORKDIR /app
ENV CI=true
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/domain/package.json packages/domain/package.json
RUN pnpm install --frozen-lockfile

COPY tsconfig.base.json ./
COPY apps/api apps/api
COPY packages/config packages/config
COPY packages/contracts packages/contracts
COPY packages/db packages/db
COPY packages/domain packages/domain
RUN pnpm --filter @deploylite/api... build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN corepack enable && addgroup -S deploylite && adduser -S deploylite -G deploylite
COPY --from=build --chown=deploylite:deploylite /app /app
USER deploylite
EXPOSE 3001
CMD ["node", "apps/api/dist/index.js"]

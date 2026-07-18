# syntax=docker/dockerfile:1.7

FROM node:24.12.0-alpine@sha256:c921b97d4b74f51744057454b306b418cf693865e73b8100559189605f6955b8 AS build
WORKDIR /app
ENV CI=true
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN pnpm install --frozen-lockfile

COPY tsconfig.base.json ./
COPY apps/web apps/web
COPY packages/contracts packages/contracts
RUN pnpm --filter @deploylite/contracts build && pnpm --filter @deploylite/web build

FROM node:24.12.0-alpine@sha256:c921b97d4b74f51744057454b306b418cf693865e73b8100559189605f6955b8 AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN corepack enable && addgroup -S deploylite && adduser -S deploylite -G deploylite
COPY --from=build --chown=deploylite:deploylite /app /app
USER deploylite
EXPOSE 3000
CMD ["pnpm", "--filter", "@deploylite/web", "exec", "next", "start", "--hostname", "0.0.0.0", "--port", "3000"]

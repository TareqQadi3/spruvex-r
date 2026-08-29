# Production image for the Platform Admin SPA (Vite/React).
#
# Build from the REPO ROOT:
#   docker build -f apps/platform/Dockerfile -t spruvex-r-platform .
#
# Deliberately not parameterized by a build ARG (unlike an earlier version
# of this file) — several hosting platforms (Render among them) don't
# support passing custom Docker build arguments at all, so dashboard/pos/kds
# each get their own equally-simple, concrete Dockerfile instead of sharing
# one parameterized template.
#
# NOTE: not build-verified in this sandbox (no Docker daemon here) — validate
# with a real `docker build` in CI before a production deploy.

FROM node:22-slim AS base
RUN corepack enable
WORKDIR /repo

FROM base AS deps
COPY pnpm-lock.yaml package.json pnpm-workspace.yaml ./
COPY apps/platform/package.json apps/platform/package.json
COPY packages/ui/package.json packages/ui/package.json
COPY packages/types/package.json packages/types/package.json
COPY packages/config/package.json packages/config/package.json
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY packages/ui packages/ui
COPY packages/types packages/types
COPY packages/config packages/config
COPY apps/platform apps/platform
RUN pnpm --filter @spruvex-r/types build
RUN pnpm --filter @spruvex-r/ui build
RUN pnpm --filter @spruvex-r/platform build

FROM nginx:1.27-alpine AS runtime
# Default matches the docker-compose service alias; override on platforms
# without Compose-style service-name DNS (e.g. Render) with that platform's
# internal address for the api service.
ENV API_INTERNAL_ORIGIN=http://api:3000
COPY infra/docker/spa.nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /repo/apps/platform/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost/ >/dev/null || exit 1

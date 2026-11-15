# syntax=docker/dockerfile:1
# Build from the repository root:
#   docker build -f apps/web-bff/Dockerfile -t repuestossur/web-bff:p4-local .
# Context exclusions live in apps/web-bff/Dockerfile.dockerignore.

FROM node:24-bookworm-slim AS build
WORKDIR /repo/apps/web-bff
COPY apps/web-bff/package.json apps/web-bff/package-lock.json ./
RUN npm ci
COPY apps/web-bff/tsconfig.json apps/web-bff/tsconfig.build.json ./
COPY apps/web-bff/src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production \
    BFF_HOST=0.0.0.0 \
    BFF_PORT=3002
WORKDIR /app
COPY --from=build --chown=node:node /repo/apps/web-bff/package.json ./
COPY --from=build --chown=node:node /repo/apps/web-bff/node_modules ./node_modules
COPY --from=build --chown=node:node /repo/apps/web-bff/dist ./dist
USER node
EXPOSE 3002
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:3002/health', { signal: AbortSignal.timeout(2000) }).then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"
STOPSIGNAL SIGTERM
CMD ["node", "dist/src/main.js"]

# syntax=docker/dockerfile:1
# Build from the repository root:
#   docker build -f apps/api-gateway/Dockerfile -t repuestossur/api-gateway:p4-local .
# Context exclusions live in apps/api-gateway/Dockerfile.dockerignore.

FROM node:24-bookworm-slim AS build
WORKDIR /repo/apps/api-gateway
COPY apps/api-gateway/package.json apps/api-gateway/package-lock.json ./
RUN npm ci
COPY apps/api-gateway/tsconfig.json apps/api-gateway/tsconfig.build.json ./
COPY apps/api-gateway/src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production \
    GATEWAY_HOST=0.0.0.0 \
    GATEWAY_PORT=8080
WORKDIR /app
COPY --from=build --chown=node:node /repo/apps/api-gateway/package.json ./
COPY --from=build --chown=node:node /repo/apps/api-gateway/node_modules ./node_modules
COPY --from=build --chown=node:node /repo/apps/api-gateway/dist ./dist
USER node
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:8080/health', { signal: AbortSignal.timeout(2000) }).then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"
STOPSIGNAL SIGTERM
CMD ["node", "dist/src/main.js"]

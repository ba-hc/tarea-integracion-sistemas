# syntax=docker/dockerfile:1
# Build from the repository root: docker build -f apps/payments-api/Dockerfile .
FROM node:24-bookworm-slim AS base
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /repo/apps/payments-api

FROM base AS build
COPY apps/payments-api/package.json apps/payments-api/package-lock.json ./
RUN npm ci
COPY apps/payments-api/ ./
RUN npm run build && npm prune --omit=dev

FROM base AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3003
COPY --from=build /repo/apps/payments-api/package.json /repo/apps/payments-api/prisma.config.ts ./
COPY --from=build /repo/apps/payments-api/node_modules ./node_modules
COPY --from=build /repo/apps/payments-api/prisma ./prisma
COPY --from=build /repo/apps/payments-api/dist ./dist
USER node
EXPOSE 3003
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + process.env.PORT + '/internal/v1/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["sh", "-c", "./node_modules/.bin/prisma migrate deploy && exec node dist/src/main.js"]

# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS base
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /repo/apps/dispatch-api

FROM base AS build
COPY apps/dispatch-api/package.json apps/dispatch-api/package-lock.json ./
RUN npm ci
COPY apps/dispatch-api/ ./
RUN npm run build && npm prune --omit=dev

FROM base AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3001
COPY --from=build /repo/apps/dispatch-api/package.json /repo/apps/dispatch-api/prisma.config.ts ./
COPY --from=build /repo/apps/dispatch-api/node_modules ./node_modules
COPY --from=build /repo/apps/dispatch-api/prisma ./prisma
COPY --from=build /repo/apps/dispatch-api/dist ./dist
USER node
EXPOSE 3001
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + process.env.PORT + '/internal/v1/health').then(response => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["sh", "-c", "./node_modules/.bin/prisma migrate deploy && exec node dist/src/main.js"]

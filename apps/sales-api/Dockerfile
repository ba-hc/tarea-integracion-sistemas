# syntax=docker/dockerfile:1
# Build from the repository root: docker build -f apps/sales-api/Dockerfile .
FROM node:24-bookworm-slim AS base
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /repo/apps/sales-api

FROM base AS build
COPY apps/sales-api/package.json apps/sales-api/package-lock.json ./
RUN npm ci
COPY apps/sales-api/ ./
COPY contracts/grpc/ /repo/contracts/grpc/
RUN npm run build && npm prune --omit=dev

FROM base AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
COPY contracts/grpc/ /repo/contracts/grpc/
COPY --from=build /repo/apps/sales-api/package.json /repo/apps/sales-api/prisma.config.ts ./
COPY --from=build /repo/apps/sales-api/node_modules ./node_modules
COPY --from=build /repo/apps/sales-api/prisma ./prisma
COPY --from=build /repo/apps/sales-api/dist ./dist
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["sh", "-c", "./node_modules/.bin/prisma migrate deploy && exec node dist/src/main.js"]
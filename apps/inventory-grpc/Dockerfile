# syntax=docker/dockerfile:1
#
# Inventory gRPC. El contexto de build es la RAÍZ del repositorio, porque el
# servicio carga el contrato congelado desde contracts/grpc:
#
#   docker build -f apps/inventory-grpc/Dockerfile -t repuestossur/inventory-grpc .
#
# Las exclusiones del contexto están en Dockerfile.dockerignore (junto a este archivo).

FROM node:24-bookworm-slim AS base
# Prisma necesita OpenSSL para su motor de migraciones.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /repo/apps/inventory-grpc

FROM base AS build
COPY apps/inventory-grpc/package.json apps/inventory-grpc/package-lock.json ./
RUN npm ci
COPY apps/inventory-grpc/ ./
RUN npm run build && npm prune --omit=dev

FROM base AS runtime
ENV NODE_ENV=production \
    GRPC_HOST=0.0.0.0 \
    GRPC_PORT=50051 \
    SEED_ON_START=true
# Misma estructura que el repo: la ruta por defecto al .proto
# (../../contracts/...) funciona sin configuración extra.
COPY contracts/grpc /repo/contracts/grpc
COPY --from=build /repo/apps/inventory-grpc/package.json /repo/apps/inventory-grpc/prisma.config.ts ./
COPY --from=build /repo/apps/inventory-grpc/node_modules ./node_modules
COPY --from=build /repo/apps/inventory-grpc/prisma ./prisma
COPY --from=build /repo/apps/inventory-grpc/dist ./dist
USER node
EXPOSE 50051
# Al arrancar: 1) aplica migraciones pendientes, 2) inserta las piezas del seed
# que falten (nunca pisa stock existente), 3) reemplaza el shell por node
# (exec) para que reciba SIGTERM directamente y cierre de forma ordenada.
CMD ["sh", "-c", "./node_modules/.bin/prisma migrate deploy && if [ \"$SEED_ON_START\" = \"true\" ]; then node dist/prisma/seed.js; fi && exec node dist/src/main.js"]

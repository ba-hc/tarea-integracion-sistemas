# syntax=docker/dockerfile:1
# Build from the repository root: docker build -f apps/payment-gateway-sim/Dockerfile .
FROM node:24-bookworm-slim
WORKDIR /repo/apps/payment-gateway-sim
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3010
COPY apps/payment-gateway-sim/package.json ./
COPY apps/payment-gateway-sim/src ./src
USER node
EXPOSE 3010
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + process.env.PORT + '/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "src/main.mjs"]

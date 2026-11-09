# Standalone Dev Chat relay.
# Build from the repository root, because the relay uses code in shared/:
#   docker build -f server/Dockerfile -t dev-chat-relay .

FROM node:22-alpine AS build
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci
COPY shared/ /app/shared/
COPY server/tsconfig.json ./
COPY server/src/ ./src/
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
ENV NODE_ENV=production \
    PORT=8787 \
    DATA_DIR=/app/server/relay-data
WORKDIR /app/server
COPY --from=build --chown=node:node /app/server/package.json ./
COPY --from=build --chown=node:node /app/server/node_modules ./node_modules
COPY --from=build --chown=node:node /app/server/dist ./dist
# The relay's self-signed certificate and private key are kept here so its
# fingerprint survives container restarts. Mount a volume to keep it.
RUN mkdir -p /app/server/relay-data && chown node:node /app/server/relay-data && chmod 700 /app/server/relay-data
VOLUME /app/server/relay-data
USER node
EXPOSE 8787
CMD ["node", "dist/server/src/server.js"]

# Standalone Dev Chat relay.
# Build from the repository root, because the relay uses code in shared/:
#   docker build -f server/Dockerfile -t dev-chat-relay .

FROM node:26-alpine AS build
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci
COPY shared/ /app/shared/
COPY server/tsconfig.json ./
COPY server/src/ ./src/
RUN npm run build && npm prune --omit=dev

FROM node:26-alpine
ENV NODE_ENV=production \
    PORT=8787 \
    DATA_DIR=/app/server/relay-data
WORKDIR /app/server
COPY --from=build --chown=node:node /app/server/package.json ./
COPY --from=build --chown=node:node /app/server/node_modules ./node_modules
COPY --from=build --chown=node:node /app/server/dist ./dist
# Keep the certificate, private key, and protected access state across restarts.
# Mount a volume to preserve them when the container is recreated.
RUN mkdir -p /app/server/relay-data && chown node:node /app/server/relay-data && chmod 700 /app/server/relay-data
VOLUME /app/server/relay-data
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 CMD node -e "const tls=!/^(1|true|yes)$/i.test((process.env.TLS_DISABLED||'').trim());const client=tls?require('node:https'):require('node:http');const req=client.get({hostname:'127.0.0.1',port:Number(process.env.PORT||8787),path:'/health',...(tls?{rejectUnauthorized:false}:{})},res=>{res.resume();process.exit(res.statusCode===200?0:1)});req.on('error',()=>process.exit(1))"
CMD ["node", "dist/server/src/server.js"]

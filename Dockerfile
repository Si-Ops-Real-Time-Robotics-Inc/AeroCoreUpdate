FROM node:24-alpine

# openssl is needed to generate a self-signed certificate on first boot: Node's
# crypto.X509Certificate can parse certificates but cannot sign new ones.
RUN apk add --no-cache openssl curl

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY public ./public
COPY docker ./docker
RUN chmod +x docker/entrypoint.sh

# /data holds the artifacts, the signing key and the TLS material — everything that must
# survive a container rebuild.
RUN mkdir -p /data && chown -R node:node /data /app
USER node

ENV NODE_ENV=production \
    PORT=9443 \
    HOST=0.0.0.0 \
    ARTIFACTS_DIR=/data/artifacts \
    SIGNING_KEY_FILE=/data/ota-signing.key \
    TLS_CERT_FILE=/data/tls/server.crt \
    TLS_KEY_FILE=/data/tls/server.key

EXPOSE 9443

# -k because the default certificate is self-signed; this only checks our own liveness.
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD curl -fsk https://127.0.0.1:9443/api/v1/health || exit 1

ENTRYPOINT ["docker/entrypoint.sh"]
CMD ["node", "src/server.js"]

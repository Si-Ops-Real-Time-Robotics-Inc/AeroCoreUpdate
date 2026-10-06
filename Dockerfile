# ── the admin UI ─────────────────────────────────────────────────────────────
# Built here rather than committed: the bundle is generated output, and the
# issuer it signs in against is a deployment fact, not a source fact.
#
# The result REPLACES public/admin in the runtime stage. The repository's own
# public/admin is left alone on purpose — it still holds the previous admin UI,
# which is what tests/ui.test.js imports and what a fallback build restores.
FROM node:24-alpine AS webui

WORKDIR /build/webui
COPY webui/package.json webui/package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY webui ./
# Read by Vite at BUILD time and baked into the bundle. Neither is a secret:
# this is a PUBLIC OIDC client doing PKCE, so there is no client secret to leak.
# Empty issuer builds a bundle that offers only the local break-glass account.
ARG VITE_OIDC_ISSUER=
ARG VITE_OIDC_CLIENT_ID=aeroserver-webui
ENV VITE_OIDC_ISSUER=$VITE_OIDC_ISSUER \
    VITE_OIDC_CLIENT_ID=$VITE_OIDC_CLIENT_ID
RUN npm run build

FROM node:24-alpine

# openssl is needed to generate a self-signed certificate on first boot: Node's
# crypto.X509Certificate can parse certificates but cannot sign new ones.
RUN apk add --no-cache openssl curl

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY public ./public
# Both UIs ship, and that is deliberate until the port finishes: the new bundle
# is the default at /admin/, while the previous UI stays reachable at
# /admin/legacy.html because it is still the only way to publish a release —
# Publish, Rollout, Fleet, Systems and Security have not been ported yet.
#
# It keeps this directory rather than moving to one of its own: its asset URLs
# are absolute (/admin/app.js, /admin/styles.css), so a copy anywhere else
# loads a blank page. Only its entry document is renamed, which is what stops
# it from being served as /admin/ itself.
#
# Docker's COPY merges rather than replaces, so the move below is what keeps the
# two sets of files from silently overlapping.
RUN mv ./public/admin ./public/.admin-previous && mkdir -p ./public/admin
COPY --from=webui /build/public/.admin-build ./public/admin
RUN cd ./public/.admin-previous \
 && cp app.js api.js login.js styles.css login.html ../admin/ \
 && cp index.html ../admin/legacy.html \
 && cd .. && rm -rf .admin-previous
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

#!/bin/sh
set -eu

# Generate a self-signed certificate when none is mounted, so `docker compose up` works with
# no preparation. The certificate lives on the data volume, so a restart keeps the same
# identity — a node that was told to trust this fingerprint keeps trusting it.
#
# subjectAltName is not optional: modern browsers ignore CN entirely, and a client that
# verifies the certificate rejects any address not listed there. The container cannot discover
# the address clients will actually dial — its own IPs are the docker-internal 172.x ones — so
# reaching this server from another machine means naming that address in TLS_SAN.

CERT="${TLS_CERT_FILE:-/data/tls/server.crt}"
KEY="${TLS_KEY_FILE:-/data/tls/server.key}"
CN="${TLS_CN:-aerocoreupdate}"

# TLS_SAN entries may be written as DNS:name or IP:addr, or bare — a bare entry that looks
# like an IPv4 address becomes IP:, anything else DNS:.
build_san() {
  san="DNS:${CN},DNS:localhost,IP:127.0.0.1"
  for entry in $(echo "${TLS_SAN:-}" | tr ',' ' '); do
    [ -z "$entry" ] && continue
    case "$entry" in
      DNS:*|IP:*) san="${san},${entry}" ;;
      *[0-9].[0-9]*.[0-9]*.[0-9]*) san="${san},IP:${entry}" ;;
      *) san="${san},DNS:${entry}" ;;
    esac
  done
  echo "$san"
}

if [ ! -f "$CERT" ] && [ ! -f "$KEY" ]; then
  SAN="$(build_san)"
  echo "entrypoint: no certificate at $CERT, generating a self-signed one"
  echo "entrypoint: subjectAltName=$SAN"
  mkdir -p "$(dirname "$CERT")" "$(dirname "$KEY")"
  openssl req -x509 -newkey rsa:2048 -sha256 -days 825 -nodes \
    -keyout "$KEY" -out "$CERT" \
    -subj "/CN=$CN" \
    -addext "subjectAltName=$SAN" >/dev/null 2>&1
  chmod 600 "$KEY"
  echo "entrypoint: fingerprint $(openssl x509 -in "$CERT" -noout -fingerprint -sha256)"
elif [ ! -f "$CERT" ] || [ ! -f "$KEY" ]; then
  echo "entrypoint: TLS is half-configured — one of $CERT / $KEY is missing" >&2
  exit 1
else
  # A certificate that does not name the address clients dial is the single most common reason
  # for "it works locally but not from another machine", so print what this one covers.
  echo "entrypoint: using the existing certificate at $CERT"
  openssl x509 -in "$CERT" -noout -ext subjectAltName 2>/dev/null | sed 's/^/entrypoint: /'
fi

mkdir -p "${ARTIFACTS_DIR:-/data/artifacts}"

exec "$@"

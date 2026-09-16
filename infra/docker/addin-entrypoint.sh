#!/bin/sh
# ---------------------------------------------------------------------------
# Certificate bootstrap for the @oao/addin nginx image.
#
# Office Add-ins require HTTPS, so nginx always listens with TLS. In
# production a real certificate is mounted at /etc/nginx/certs (cert-manager
# Secret via the Helm chart, or a bind mount with docker compose) and this
# script does nothing. Otherwise — dev/demo only — it generates a throwaway
# self-signed certificate so the container can still start.
#
# Runs under a read-only root filesystem: /etc/nginx/certs is the only path
# it touches, and it must be writable for the self-signed path (emptyDir).
# ---------------------------------------------------------------------------
set -eu

CERT_DIR="/etc/nginx/certs"
CERT_FILE="$CERT_DIR/addin.crt"
KEY_FILE="$CERT_DIR/addin.key"

if [ -s "$CERT_FILE" ] && [ -s "$KEY_FILE" ]; then
  echo "[addin-entrypoint] certificate found in $CERT_DIR — nothing to do"
  exit 0
fi

if ! mkdir -p "$CERT_DIR" 2>/dev/null || [ ! -w "$CERT_DIR" ]; then
  echo "[addin-entrypoint] ERROR: no certificate in $CERT_DIR and the directory is not writable." >&2
  echo "[addin-entrypoint] Mount a TLS secret there (addin.crt + addin.key), or set addin.tls.mode=selfSigned." >&2
  exit 1
fi

HOSTNAME_FOR_CERT="${ADDIN_HOST:-addin.oao.northbridge.example}"
echo "[addin-entrypoint] no certificate mounted — generating a self-signed one for CN=${HOSTNAME_FOR_CERT} (dev/demo only)"
openssl req -x509 -nodes -newkey rsa:2048 -days 365 \
  -keyout "$KEY_FILE" -out "$CERT_FILE" \
  -subj "/C=CH/ST=Geneva/L=Geneva/O=Northbridge Capital/OU=OAO/CN=${HOSTNAME_FOR_CERT}" \
  -addext "subjectAltName=DNS:${HOSTNAME_FOR_CERT},DNS:localhost,IP:127.0.0.1" \
  >/tmp/gen-cert.log 2>&1
chmod 0400 "$KEY_FILE" 2>/dev/null || true
echo "[addin-entrypoint] self-signed certificate generated — Outlook will refuse it, use cert-manager in production"

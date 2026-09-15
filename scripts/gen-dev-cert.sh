#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Generates a localhost HTTPS certificate for the add-in dev server
# (https://localhost:3000, required by Office.js / Outlook add-ins) and for
# the addin nginx Docker image (apps/addin/certs -> mounted at
# /etc/nginx/certs). Prefers mkcert (trusted by the OS/browser, no warnings);
# falls back to a plain openssl self-signed cert otherwise.
# ---------------------------------------------------------------------------
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="$ROOT_DIR/apps/addin/certs"
mkdir -p "$OUT_DIR"

CERT="$OUT_DIR/addin.crt"
KEY="$OUT_DIR/addin.key"

if command -v mkcert >/dev/null 2>&1; then
  echo "==> mkcert found — generating a locally-trusted certificate"
  mkcert -install >/dev/null 2>&1 || true
  mkcert -cert-file "$CERT" -key-file "$KEY" localhost 127.0.0.1 ::1 addin.northbridge.local
else
  echo "==> mkcert not found — falling back to a self-signed openssl certificate"
  echo "    (browsers will warn; for a trusted local cert install mkcert: https://github.com/FiloSottile/mkcert)"
  openssl req -x509 -nodes -newkey rsa:2048 -days 365 \
    -keyout "$KEY" -out "$CERT" \
    -subj "/C=CH/ST=Geneva/L=Geneva/O=Northbridge Capital/OU=OAO/CN=localhost" \
    -addext "subjectAltName=DNS:localhost,DNS:addin.northbridge.local,IP:127.0.0.1"
fi

chmod 600 "$KEY"
echo "==> Certificate written to:"
echo "    $CERT"
echo "    $KEY"
echo "==> Office add-in dev server (office-addin-dev-certs) uses its own cert store;"
echo "    run 'pnpm --filter @oao/addin certs' for that one. These files are for the"
echo "    addin Docker image / any server that needs a manual cert (see docker-compose.yml)."

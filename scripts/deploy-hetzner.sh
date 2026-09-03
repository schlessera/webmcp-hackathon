#!/usr/bin/env bash
# Bootstrap the Spokes stack on a fresh Ubuntu host.
# Run ON THE SERVER as root, from /root/spokes (repo checkout + .env already there).
set -euo pipefail

REPO_DIR=/root/spokes
cd "$REPO_DIR"

echo "==> Docker"
if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sh
fi
docker --version
docker compose version

echo "==> Firewall"
if command -v ufw >/dev/null; then
  ufw allow 22/tcp   >/dev/null
  ufw allow 80/tcp   >/dev/null
  ufw allow 443/tcp  >/dev/null
  ufw --force enable >/dev/null
  ufw status numbered
fi

echo "==> Required env"
: "${APP_DOMAIN:?export APP_DOMAIN=spokes.example.com}"
grep -q '^DEMO_SECRET_KEY=' .env || { echo "FAIL: DEMO_SECRET_KEY missing from .env"; exit 1; }

# APP_URL must match the public origin so seeded invite links resolve.
if grep -q '^APP_URL=' .env; then
  sed -i "s#^APP_URL=.*#APP_URL=https://${APP_DOMAIN}#" .env
else
  echo "APP_URL=https://${APP_DOMAIN}" >> .env
fi
# A real password for a public deployment; generated once and kept in .env.
if ! grep -q '^POSTGRES_PASSWORD=' .env; then
  echo "POSTGRES_PASSWORD=$(openssl rand -hex 24)" >> .env
fi
grep -q '^APP_DOMAIN=' .env || echo "APP_DOMAIN=${APP_DOMAIN}" >> .env
# Clients reload when the build id changes.
if grep -q '^SOURCE_COMMIT=' .env; then
  sed -i "s#^SOURCE_COMMIT=.*#SOURCE_COMMIT=$(cat .commit 2>/dev/null || echo manual)#" .env
else
  echo "SOURCE_COMMIT=$(cat .commit 2>/dev/null || echo manual)" >> .env
fi

echo "==> Build and start (migrate -> seed -> app -> caddy)"
docker compose -f compose.coolify.yaml -f compose.prod.yaml up -d --build

echo "==> Status"
docker compose -f compose.coolify.yaml -f compose.prod.yaml ps

# A build that fails leaves the previous containers running, so `ps` alone can
# look healthy while the new bundle never shipped. Assert the served build id.
echo "==> Verify the served build"
WANT=$(cat .commit 2>/dev/null || echo manual)
for _ in $(seq 1 40); do
  META=$(docker compose -f compose.coolify.yaml -f compose.prod.yaml exec -T app \
    wget -qO- http://127.0.0.1:4173/api/meta 2>/dev/null || true)
  case "$META" in *'"buildId":"'"$WANT"'"'*) break ;; esac
  sleep 3
done
echo "$META"
case "$META" in
  *'"buildId":"'"$WANT"'"'*) echo "ok: app serves $WANT" ;;
  *) echo "FAIL: app is not serving $WANT (see above)"; exit 1 ;;
esac

echo "==> Verify the public origin"
curl -fsS --max-time 20 "https://${APP_DOMAIN}/api/meta" && echo || {
  echo "FAIL: https://${APP_DOMAIN}/api/meta did not answer"; exit 1; }

echo "==> Invite links (secret-bearing)"
docker compose -f compose.coolify.yaml -f compose.prod.yaml logs seed | tail -30

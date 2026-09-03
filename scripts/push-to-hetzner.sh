#!/usr/bin/env bash
# Run LOCALLY. Ships the repo + .env to the server and runs the bootstrap.
#   APP_DOMAIN=spokes.example.com scripts/push-to-hetzner.sh
set -euo pipefail

HOST="${HOST:-root@5.78.128.214}"
: "${APP_DOMAIN:?export APP_DOMAIN=spokes.example.com}"
SSH_OPTS=(-o StrictHostKeyChecking=accept-new -o ConnectTimeout=15)

echo "==> Sync repo (git-tracked files only)"
ssh "${SSH_OPTS[@]}" "$HOST" 'mkdir -p /root/spokes'
git ls-files -z | tar --null -T - -czf - | ssh "${SSH_OPTS[@]}" "$HOST" 'tar -xzf - -C /root/spokes'

echo "==> Sync untracked deploy files"
ssh "${SSH_OPTS[@]}" "$HOST" 'mkdir -p /root/spokes/scripts'
scp "${SSH_OPTS[@]}" compose.prod.yaml Caddyfile "$HOST":/root/spokes/
scp "${SSH_OPTS[@]}" scripts/deploy-hetzner.sh "$HOST":/root/spokes/scripts/

echo "==> Sync secrets (.env is gitignored, copied separately)"
# The host generates POSTGRES_PASSWORD on first deploy and the database volume
# is initialised with it. Overwriting .env wholesale would strand that volume
# behind an unrecoverable password, so carry any host-generated value across.
KEEP=$(ssh "${SSH_OPTS[@]}" "$HOST" 'grep "^POSTGRES_PASSWORD=" /root/spokes/.env 2>/dev/null' || true)
scp "${SSH_OPTS[@]}" .env "$HOST":/root/spokes/.env
if [ -n "$KEEP" ] && ! grep -q '^POSTGRES_PASSWORD=' .env; then
  ssh "${SSH_OPTS[@]}" "$HOST" "printf '%s\n' '$KEEP' >> /root/spokes/.env"
fi
ssh "${SSH_OPTS[@]}" "$HOST" 'chmod 600 /root/spokes/.env'

echo "==> Record the commit for BUILD_ID"
git rev-parse --short HEAD | ssh "${SSH_OPTS[@]}" "$HOST" 'cat > /root/spokes/.commit'

echo "==> Bootstrap"
ssh "${SSH_OPTS[@]}" "$HOST" "cd /root/spokes && export APP_DOMAIN='${APP_DOMAIN}' && bash scripts/deploy-hetzner.sh"

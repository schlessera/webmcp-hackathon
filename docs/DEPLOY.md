# Deploying Spokes

The live deployment is **Caddy in front of the compose stack on a plain Docker
host** (Hetzner, `root@5.78.128.214`, `spokes.alainschlesser.com`). Coolify was
prepared and abandoned at the gate; `docs/DEPLOY-COOLIFY.md` still describes
that path and still carries the authoritative environment-variable table, which
is current even though its platform is not.

Two files compose the stack: `compose.coolify.yaml` (db, migrate, seed, app) and
`compose.prod.yaml` (Caddy, TLS, ports 80/443). Two scripts drive it:
`scripts/push-to-hetzner.sh` runs locally and ships; `scripts/deploy-hetzner.sh`
runs on the server and bootstraps.

## The one command

```sh
APP_DOMAIN=spokes.alainschlesser.com scripts/push-to-hetzner.sh
```

It syncs the repo, syncs `.env`, records the commit, and runs the bootstrap over
ssh. Roughly three minutes end to end, most of it the image build on the host.

## Before you run it

**The working tree is what ships, not the commit.** The sync is
`git ls-files -z | tar --null -T -`: `ls-files` names tracked paths, `tar` reads
them from the working tree. Uncommitted edits to tracked files ship. Untracked
files never do. Meanwhile `BUILD_ID` comes from `git rev-parse --short HEAD`, so
a dirty tree labels production with a commit whose content it is not serving.

```sh
git status --short          # no ` M ` lines before pushing
```

**Check `apps/web/index.html` specifically.** Design tooling that injects a live
-reload tag writes into it, and the block is easy to miss in a status listing:

```html
<!-- impeccable-live-start -->
<script src="http://localhost:8400/live.js?token=…"></script>
<!-- impeccable-live-end -->
```

Shipping that puts a `http://localhost` script tag and a session token into the
production document. Browsers block it as mixed content, so the page still
works — but the token is public and the markup is wrong. Strip the block, and
confirm the built bundle is clean:

```sh
pnpm --filter @webmcp-hackathon/web build
grep -c "impeccable\|8400" apps/web/dist/index.html   # must print 0
```

**Gate on the fast checks.** `pnpm -r typecheck` and `pnpm test:unit` (about
five seconds, 750+ tests) catch what the deploy will not. The api and e2e lanes
need the docker stack and a lane lock; they are not a deploy gate.

**Check for migrations.** `git diff --name-status <deployed>..HEAD -- '*migrations*'`.
An empty result means the deploy cannot touch the schema. A non-empty one means
reading the migration before pushing, because it runs against live data and
applied migrations are immutable.

## What happens on the host

`migrate` runs and must exit 0 before `seed`; `seed` is idempotent and tops up
`room_demo` without wiping a live session's widened scope; `app` waits on both
and gates `caddy` on its own health check. A failed image build leaves the
previous containers running and serving — which is safe, and which is why the
bootstrap does not trust `docker compose ps`. It polls `/api/meta` inside the
app container until `buildId` matches `.commit`, then checks the public origin
through Caddy, and exits non-zero if either does not answer.

## Verify

```sh
curl -s https://spokes.alainschlesser.com/api/meta
# {"buildId":"<short sha>","toolContractVersion":"3","nl":true}

curl -sI https://spokes.alainschlesser.com/ | grep -i origin-trial
```

The `Origin-Trial` header is a base64 blob; decoding its payload should show
`{"origin":"https://spokes.alainschlesser.com:443","feature":"WebMCP",…}` with
an expiry in the future. Without it the page is a normal web app and ChatGPT's
built-in browser discovers no site tools.

## Pitfalls

**`POSTGRES_PASSWORD` lives only on the host.** It is generated there on the
first deploy and the database volume is initialised with it; the local `.env`
does not have it. The push reads the host `.env`, carries the value across the
overwrite, and keeps the previous file as `.env.bak`. It **refuses to push**
when the host has an `.env` without a password line and the local one has none
either — because bootstrapping would mint a fresh password the existing volume
cannot accept, and the data would be unrecoverable. If you hit that refusal, do
not work around it: recover the value from `.env.bak` or the running container's
environment first.

**`APP_URL` in the local `.env` is not the production URL.** The bootstrap
rewrites it from `APP_DOMAIN` on the host, so a stale tunnel URL locally is
harmless — but it is also why `APP_DOMAIN` is mandatory rather than inferred.

**Invite links are secret-bearing.** The bootstrap prints the `seed` container
logs at the end. They embed guest secrets in URL fragments. Treat the deploy
log as a secret.

**`DEMO_SECRET_KEY` must never change.** Invite secrets are HMAC-derived from
it, so rotating it invalidates every link already handed out.

**Smoke-testing the live app changes the live room.** `room_demo` is shared
state that persists across deploys, and the invite links handed to judges open
it. Submitting a need to prove the deploy works leaves that need on the board
for everyone. Read-only checks — `/api/meta`, an invite exchange, a WebSocket
that receives frames — prove the same thing without writing. If a check does
write, undo it explicitly:

```sh
# the requirement ids live in the db
docker compose -f compose.coolify.yaml -f compose.prod.yaml exec -T db \
  psql -U webmcp -d webmcp -At -c \
  "select id, owner_id, payload::text from requirements where room_id='room_demo' and withdrawn = false;"
```

then withdraw it as its owner (`POST /api/commands`, type `WithdrawRequirement`,
with the current `revision` from `/api/sync` as `baseRevision`, and the
`x-tool-contract-version: 3` header — commands without that header are rejected).
Withdrawing is the reversible path; `seed --reset` is the blunt one and also
discards whatever the room has explored.

## Rollback

There is no git checkout on the host — the sync is a tarball, so the server has
no history to roll back to. Roll back from the local checkout:

```sh
git stash                                    # if the tree is dirty
git checkout <last-good-sha>
APP_DOMAIN=spokes.alainschlesser.com scripts/push-to-hetzner.sh
git checkout -                               # and unstash
```

The database volume is untouched by any of this. The previous image also still
exists on the host until it is pruned, so `docker compose … up -d --no-build`
against the old image is a faster stopgap when the problem is a bad build rather
than bad code.

## Reset the demo room

```sh
ssh root@5.78.128.214 'cd /root/spokes && \
  docker compose -f compose.coolify.yaml -f compose.prod.yaml \
  run --rm seed node apps/server/src/seed.ts --reset'
```

Scoped to `room_demo`; it resets the scope to the initial 800 m and never
touches the volume. Use it when the map hangs on "Loading the shared map…",
which means `room_demo.scope` is NULL.

## During the judging window

Judging runs 4–21 September 2026 against the live URL. Every push rebuilds and
restarts the app container, so there is a downtime window of a few seconds.
Prefer not to push at all; if you must, push a tree that has passed typecheck
and unit tests, and verify `/api/meta` immediately after.

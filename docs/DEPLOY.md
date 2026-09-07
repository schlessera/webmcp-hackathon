# Deploying Spokes

Current deployment runbook, checked against the repository scripts on
2026-09-07. The configured target is a plain Docker host with Caddy in front
of the application (`root@5.78.128.214`, `spokes.alainschlesser.com`). This
reference does not establish which build or configuration is running there.

[compose.coolify.yaml](../compose.coolify.yaml) defines Postgres, migrations,
seed, and the application. [compose.prod.yaml](../compose.prod.yaml) adds
Caddy, TLS, and host ports 80/443. Despite the base filename, this deployment
does not require Coolify. The [environment table](DEPLOY-COOLIFY.md#2-environment-variables)
applies to the base stack; that document also describes an unverified
alternative Coolify setup.

## Deploy command

From a checkout with the intended tracked files and deployment `.env`:

```sh
APP_DOMAIN=spokes.alainschlesser.com scripts/push-to-hetzner.sh
```

`HOST` overrides the script's default SSH target. The script copies the
tracked working tree, selected deployment files, and `.env` to `/root/spokes`,
records the local commit, and runs the host bootstrap. It changes the live
application and can run database migrations. It does not push Git commits.

## Prepare the release

1. **Review the working tree.** The script uses `git ls-files` to choose paths
   and tar to read their current contents. Uncommitted tracked edits ship;
   ordinary untracked application files do not. `compose.prod.yaml`,
   `Caddyfile`, and `scripts/deploy-hetzner.sh` are also copied explicitly.
   `BUILD_ID` comes from `HEAD`, so commit the intended release and use a clean
   checkout to keep that label meaningful.
2. **Run relevant checks.** Use `pnpm typecheck`, `pnpm test:unit`, and the web
   build. Run API/browser scenarios appropriate to the changed behavior in
   an isolated local stack. Do not assume old test counts or dated reports
   describe this checkout.
3. **Inspect the built page.** Check `apps/web/dist/index.html` and its assets
   for development-only scripts, localhost URLs, and unintended content.
4. **Review migrations and back up durable data.** Compare the intended
   release with the deployed version, read every new migration, and verify a
   usable backup before changing production schema. The bootstrap applies
   migrations automatically. Applied migrations are immutable; code rollback
   does not reverse them.
5. **Check deployment configuration.** Set the exact public origin, actual
   trusted ingress proxy IPs/CIDRs, stable signing key, and database password.
   Configure provider keys and limits intentionally. The current application
   assumes one process for live coordination and quotas; see
   [Known limitations](KNOWN-LIMITATIONS.md).

```sh
git status --short
pnpm typecheck
pnpm test:unit
pnpm --filter @webmcp-hackathon/web build
git diff --name-status <deployed-sha>..HEAD -- apps/server/migrations
```

## What runs on the host

The [bootstrap](../scripts/deploy-hetzner.sh) installs Docker if absent and,
when UFW is available, enables it with SSH and HTTP/HTTPS allowed. It sets
`APP_URL` from `APP_DOMAIN`, generates a database password only if none is
present, and sets `SOURCE_COMMIT` from the uploaded `.commit` file.

The stack starts in dependency order: healthy database → successful
migrations → successful seed → healthy application → Caddy. Seed updates
`room_demo` without resetting its widened scope. The application serves the
prebuilt React bundle, API, and `/ws` on internal port 4173.

The bootstrap checks the app container's `/api/meta` until its `buildId`
matches `.commit`, then checks that the public `/api/meta` responds. A healthy
old container is not proof a new build shipped. The public check does not
itself compare the build ID, so inspect that response too.

## Verify the release

```sh
curl -fsS https://spokes.alainschlesser.com/api/meta
curl -fsSI https://spokes.alainschlesser.com/
```

Compare `buildId` with the intended commit. `toolContractVersion` is currently
`"3"`; the tool catalog contains 24 tools. `nl` reflects whether the selected
model backend has a key, not whether a provider request will succeed.

Open the landing page and create a disposable room for any mutation-based
smoke test. Check room creation, a newly minted member link in a separate
browser profile, realtime updates, and the relevant release behavior. An
invite exchange creates a token and is not a read-only operation. Avoid
using an active shared room as a test fixture.

For native WebMCP, check that the browser exposes `document.modelContext` and
that registration succeeds. The origin-trial token must cover the exact
HTTPS origin and still be valid if that is the browser's enablement path.
A testing flag is a separate local enablement path. An `Origin-Trial` header
alone does not prove agent discovery or host compatibility; see
[binding §2.1](protocols/INTERACTION-AND-BINDING.md#21-registration-model-static-surface).

## Secrets and persistent state

- **Preserve the database password.** The push script carries the host's
  `POSTGRES_PASSWORD` into the copied `.env` when the local file omits it,
  saves the previous environment as `.env.bak`, and refuses a known-host
  environment with no password on either side. If the local file supplies a
  different password, it takes precedence; that does not change the password
  already stored in an existing database volume.
- **Keep `DEMO_SECRET_KEY` stable.** It derives deterministic fixture
  recovery secrets. Changing it affects those links. Ordinary room organizer
  recovery secrets and member invitation secrets are randomly generated.
- **Treat deployment logs as secret-bearing.** The bootstrap prints seed
  logs containing fragment invitation secrets. They are not public logs.
  Seeded member recovery URLs are local-development fixtures; production
  members use newly minted `#join=` links. Organizer recovery expires after
  seven days, and participant bearer tokens after 24 hours.
- **Keep the public origin consistent.** Bootstrap rewrites `APP_URL` from
  `APP_DOMAIN`; Compose passes it as the application's `PUBLIC_ORIGIN` for
  origin checks. Existing `.env` `APP_DOMAIN` values also feed Caddy, so check
  the host file when changing domains.
- **Expect a restart window.** A deploy restarts the app. Room state/events
  persist in Postgres, but presence, confirmation nonces, private held text,
  and in-process quotas do not. There is no zero-downtime rollout mechanism.

## Rollback

The host receives a tarball, not Git history. Prepare a clean local worktree
at the last good commit, provide its deployment `.env`, and run the same
push script from that worktree. Check that its scripts and schema expectations
are compatible with the deployed database before shipping it.

A code rollback does not roll back data or migrations. In particular, code
expecting global fact confirmations is incompatible with the current
room-scoped confirmation schema. Prefer a forward fix when schemas differ;
a coordinated database/image restore must account for writes since the
backup. The tar upload also does not remove paths missing from the older
checkout, so inspect the resulting build context when rolling back removals.

## Reset the demo fixture

This operation discards `room_demo`'s current negotiation state; it is not a
routine health check and does not reset ordinary created rooms.

```sh
ssh root@5.78.128.214 'cd /root/spokes && docker compose -f compose.coolify.yaml -f compose.prod.yaml run --rm seed node apps/server/src/seed.ts --reset'
```

The reset restores the fixture scope to its initial 800 metres. Keep it scoped
to an intentional demo reset; it is not a general remedy for loading errors.

For warming provider caches without creating a room, follow
[Prepare a demo region](PREPOPULATE.md). Backups, restore rehearsal,
monitoring, shared quotas, provider spending controls, and restricted runtime
database credentials remain operator responsibilities described in
[Known limitations](KNOWN-LIMITATIONS.md).

# Automated three-user WebMCP demo environment (VALIDATION-SPIKE-1).
SHELL := /bin/bash
COMPOSE := docker compose

.PHONY: doctor dev demo demo-reset demo-public test test-native logs stop

doctor: ## verify Docker, ports, configuration, browser image
	@command -v docker >/dev/null || { echo "FAIL: docker missing"; exit 1; }
	@$(COMPOSE) version >/dev/null || { echo "FAIL: compose missing"; exit 1; }
	@docker info >/dev/null 2>&1 || { echo "FAIL: docker daemon not running"; exit 1; }
	@ss -ltn 2>/dev/null | grep -q ':4173 ' && echo "WARN: port 4173 already in use" || echo "ok: port 4173 free"
	@ss -ltn 2>/dev/null | grep -q ':5432 ' && echo "WARN: port 5432 already in use" || echo "ok: port 5432 free"
	@test -f pnpm-lock.yaml && echo "ok: lockfile present" || echo "WARN: run 'pnpm install' first"
	@echo "ok: doctor complete"

dev: ## start app/db/migrations with compose watch (HMR + auto-restart)
	$(COMPOSE) up --build --watch

demo: ## start everything, idempotently seed, print the three participant URLs
	$(COMPOSE) up --build --detach --wait app
	$(COMPOSE) run --rm seed-demo
	@echo "Sarah and Joe URLs open in isolated Chromium contexts via:"
	@echo "  pnpm exec node scripts/open-participants.mjs   (or open manually)"

demo-reset: ## reset ONLY the named demo room, then reseed (destructive, scoped)
	$(COMPOSE) up --detach --wait app
	$(COMPOSE) run --rm seed-demo node apps/server/src/seed.ts --reset
	$(COMPOSE) run --rm seed-demo

demo-public: ## enable the fixed HTTPS tunnel (requires TUNNEL_TOKEN + non-default DEMO_SECRET_KEY)
	@test -n "$$TUNNEL_TOKEN" || { echo "FAIL: TUNNEL_TOKEN not set"; exit 1; }
	@test -n "$$DEMO_SECRET_KEY" && test "$$DEMO_SECRET_KEY" != "local-dev-only" || { \
	  echo "FAIL: set a non-default DEMO_SECRET_KEY before exposing the app publicly —"; \
	  echo "      the default key makes every invite URL computable from the repository."; \
	  exit 1; }
	$(COMPOSE) --profile public up --detach --wait
	@echo "Reseeding the demo room so no invite derived from a previous key stays valid…"
	$(COMPOSE) run --rm seed-demo node apps/server/src/seed.ts --reset
	$(COMPOSE) run --rm seed-demo
	@echo "NOTE: invite URLs printed by seed carry secrets; treat logs as secret-bearing."

test: ## unit, contract, API, privacy, and three-user tests
	$(COMPOSE) up --detach --wait db
	$(COMPOSE) run --rm migrate
	pnpm test:unit
	pnpm test:api
	pnpm test:e2e

test-native: ## native WebMCP discovery/execution in pinned Chrome 149+
	pnpm test:native

logs: ## follow correlated app/demo logs
	$(COMPOSE) logs --follow app

stop:
	$(COMPOSE) down

.PHONY: help build up down clean clean-orphans restart logs shell install test test-watch lint format check fallow prepare typecheck bundle-repl publish-prep watch watch-bg unwatch
.DEFAULT_GOAL := help

CONTAINER := attaform-dev

help:  ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2}'

# --- Container lifecycle ---

build:  ## Build the dev image
	docker compose build

up: down  ## Stop any prior stack, regen the playground type bundle, start the dev container, and boot the docs site (http://localhost:3000)
	docker compose up -d
	docker compose exec -T attaform rm -rf /app/apps/site/node_modules/.cache/vite
	docker compose exec attaform sh -c "cd apps/site && pnpm bundle:repl"
	docker compose exec attaform pnpm dev

down:  ## Stop and remove the dev container (named node_modules volumes persist for fast restarts)
	docker compose down

clean:  ## Stop the container AND remove its named volumes — first `make up` after this re-seeds node_modules from the image
	docker compose down -v

clean-orphans:  ## One-time fix: prune dangling Docker volumes left by the old anonymous-volume layout (frees GBs from /var/lib/docker)
	docker volume prune -f

restart:  ## Rebuild image, regen the playground type bundle, and bring the dev server back up
	docker compose build
	$(MAKE) up

bundle-repl:  ## Regenerate the playground type bundle (apps/site/public/lib/types/attaform/*.d.ts)
	docker compose exec attaform sh -c "cd apps/site && pnpm bundle:repl"

logs:  ## Tail container logs
	docker compose logs -f

shell:  ## Drop into an interactive shell inside the container
	docker compose exec attaform sh

# --- pnpm scripts (run inside the container) ---

# `node_modules/` is intentionally split between two filesystems
# (named volumes in docker-compose.yml — `attaform_root_node_modules`
# and `attaform_site_node_modules`): the container has Linux binaries
# for the dev server, the host has macOS binaries for editor LSP
# tooling (vtsls, ESLint, Volar, etc.). Both must be kept in lockstep
# so a host-side LSP can resolve workspace deps that the container-
# side install registered. The single `pnpm-lock.yaml` is bind-
# mounted, so the host install picks up whatever the container's
# `--force` install resolved — no drift.
install:  ## Force-refresh deps (container + host) and run dev:prepare (lib stub + Nuxt types)
	docker compose exec attaform pnpm install --force
	pnpm install
	docker compose exec attaform pnpm dev:prepare

prepare:  ## Prepare the module for development (build stub + prepare apps/site)
	docker compose exec attaform pnpm dev:prepare

test:  ## Run the test suite once
	docker compose exec attaform pnpm test

test-watch:  ## Run tests in watch mode
	docker compose exec attaform pnpm test:watch

lint:  ## Lint
	docker compose exec attaform pnpm lint

format:  ## Format
	docker compose exec attaform pnpm format

check:  ## Lint + format check + typecheck
	docker compose exec attaform pnpm check

# Non-gating code-intelligence pass (unused code, dependency hygiene,
# duplication, circular deps, complexity). Reads the calibrated
# .fallowrc.jsonc; telemetry hard-disabled via the `fallow` script env.
# fallow is fetched with a pinned `npx fallow@<version>` (see the `fallow`
# script in package.json) rather than added to the lockfile, keeping the
# zero-runtime-deps posture intact. Runs in-container like the rest, so it
# shares the dev env (and a future coverage variant path-matches without
# a host/container remap).
fallow:  ## Run fallow code-intelligence (unused code, dupes, complexity) — non-gating
	docker compose exec attaform pnpm fallow

typecheck:  ## TypeScript check
	docker compose exec attaform pnpm typecheck

publish-prep:  ## Build the module for publishing
	docker compose exec attaform pnpm prepack

watch:  ## Rebuild dist on every src change (for consumer-side iteration via pnpm link)
	docker compose exec -e CI=true -e SHELL=/bin/sh attaform pnpm prepack:watch

watch-bg:  ## Detached watcher (PID tracked in /tmp/attaform-watch.pid) — used by attaform' make link-attaform
	@# Idempotent: if a live watcher's already tracked in the pidfile, no-op.
	@# Same /proc/$PID/cmdline check as `unwatch` — guards against a stale
	@# pidfile pointing at a recycled PID.
	@docker compose exec -e CI=true -e SHELL=/bin/sh -d attaform sh -c 'if [ -f /tmp/attaform-watch.pid ]; then PID=$$(cat /tmp/attaform-watch.pid); if [ -f /proc/$$PID/cmdline ] && tr "\0" " " < /proc/$$PID/cmdline | grep -q "prepack:watch"; then exit 0; fi; fi; pnpm prepack:watch > /tmp/attaform-watch.log 2>&1 & echo $$! > /tmp/attaform-watch.pid'

unwatch:  ## Stop the background watcher started by watch-bg
	@# Validate the stored PID via /proc/$PID/cmdline before killing — guards
	@# against PID reuse if the watcher already exited. `pkill -P PID` kills
	@# the children (chokidar) by parent-PID, so it doesn't take a regex and
	@# can't self-match. `kill PID` then takes out the pnpm parent.
	@docker compose exec attaform sh -c 'if [ -f /tmp/attaform-watch.pid ]; then PID=$$(cat /tmp/attaform-watch.pid); if [ -f /proc/$$PID/cmdline ] && tr "\0" " " < /proc/$$PID/cmdline | grep -q "prepack:watch"; then pkill -P $$PID 2>/dev/null || true; kill $$PID 2>/dev/null || true; fi; rm -f /tmp/attaform-watch.pid /tmp/attaform-watch.log; fi; true'

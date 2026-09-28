# Klang Valley Transit Reliability — MVP task runner
#
# Every module is provable by ONE command. These are those commands.
# Acceptance criteria mapping (bob-execution-prompt.md):
#   A1 -> make eval        A2 -> make test (routing/reroute.test.ts)
#   A3 -> make replay      A4 -> make verify-offline
#   A5 -> make test (routing/offline.test.ts)  A6 -> make test (ui/geometry.test.ts)
#   A7 -> make test (agents/custom-tools.test.ts)

SHELL := /bin/bash
.DEFAULT_GOAL := help

# npm 11.19 rejects an env-provided allow-scripts for project installs, and the
# global cache may be root-owned. Both are pinned to the workspace.
export npm_config_cache := $(CURDIR)/.npm-cache
NPM := env -u npm_config_allow_scripts npm

.PHONY: help install dev build start typecheck test graph eval replay verify-offline verify-router verify-all clean

help:
	@echo "Klang Valley Transit Reliability — make targets"
	@echo "  make install         install dependencies"
	@echo "  make graph           build the transit graph from GTFS static (offline, from fixture)"
	@echo "  make dev             run the Next.js dev server (UI + API, one process)"
	@echo "  make build           production build"
	@echo "  make typecheck       tsc --noEmit"
	@echo "  make test            full vitest suite"
	@echo "  make eval            A1: precision/recall/median lead time; non-zero exit if coverage < 50%"
	@echo "  make replay          A3: replay a historical disruption ingest->verify->impact->advisory"
	@echo "  make verify-offline  A4: assert zero live external network calls on the demo path"
	@echo "  make verify-router   A2: prove an injected incident changes the recommended route"
	@echo "  make verify-all      run every acceptance check in sequence"

install:
	$(NPM) install --no-audit --no-fund

dev:
	$(NPM) run dev

build:
	$(NPM) run build

start:
	$(NPM) run start

typecheck:
	./node_modules/.bin/tsc --noEmit

test:
	./node_modules/.bin/vitest run

# Builds public/graph/transit-graph.json from the committed GTFS fixture.
# Must NOT touch the network — the fixture is in data/gtfs-static/.
graph:
	./node_modules/.bin/tsx scripts/build-graph.ts

# A1 — the headline number.
eval:
	./node_modules/.bin/tsx eval/run-eval.ts

# A3 — end-to-end trace with confidence at each hop.
replay:
	./node_modules/.bin/tsx scripts/replay-incident.ts

# A4 — zero live external network calls on the demo path.
verify-offline:
	./node_modules/.bin/tsx scripts/verify-no-network.ts

# A2 — a synthetic incident must change the recommended route, offline, from the
# cached graph artifact alone.
verify-router:
	./node_modules/.bin/tsx scripts/verify-router.ts

verify-all: typecheck graph test verify-router eval replay verify-offline
	@echo ""
	@echo "=============================================="
	@echo " ALL ACCEPTANCE CHECKS PASSED"
	@echo "=============================================="

clean:
	rm -rf .next out eval/out public/graph

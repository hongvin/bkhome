# Klang Valley Transit Reliability

**Route to arrival probability, not average duration.**

Malaysian commuters in the Klang Valley don't avoid transit because of cost or
time — they avoid it because they can't trust the ETA. Official channels report
disruptions late. Existing navigation apps show scheduled time and carry no
reliability signal at all.

This app estimates the probability that a network segment is degraded, reports a
**P90** arrival window instead of a mean, and re-routes around expected **risk**
rather than expected time.

> The routing is the delivery mechanism. **The reliability signal is the product.**

---

## The two numbers

1. **Precision / recall** of the signal pipeline against the official
   myrapid.com.my media-statement archive — our free, real-world ground truth.
2. **Median lead time** — minutes between our pipeline flagging a disruption and
   the operator's own public notice. This is the answer to "why not just use
   Google Maps".

Run `make eval`.

---

## Architecture

**One Next.js deployment serves both UI and API.** There is no separate backend
process — two things to start is two things that can crash, plus CORS to debug.
The only exception is the scheduled GTFS-R ingest worker, which runs on a timer
and never serves a user request.

```
app/                     Next.js App Router — UI + API routes (one process)
  api/                   Route handlers (plan, signals, risk, reconcile, inspect)
components/              Mobile UI: map, bottom sheet, route cards, source inspector
lib/
  contracts/             FROZEN data contracts — the parallelisation interface
  gtfs/                  GTFS static ingest, graph construction
  routing/               Connection Scan Algorithm (CSA) router
  signals/               Signal store, dedupe, lifecycle
  agents/ingest/         Ingest agent
  agents/verify/         Verify agent + its system prompt
  agents/impact/         Impact agent + its system prompt
  risk/                  Risk penalty, P90 arrival model, re-ranking
  offline/               IndexedDB graph cache, staleness, reconnect reconcile
  db/                    Postgres repository (PGlite default, pg for deployment)
  mock/                  Fixture-backed data seam used before integration
  i18n/                  Bahasa Malaysia / English strings
worker/                  GTFS-R ingest worker (OFF the request path)
eval/                    Ground-truth eval harness (precision/recall/lead time)
data/gtfs-static/        Committed real GTFS fixture — routing needs no network
data/incidents/          Labelled ground-truth incidents
tests/                   Vitest suites, one directory per module
```

### Why CSA, in TypeScript

Full RAPTOR is not required. Connection Scan Algorithm is ~200 well-tested lines
and keeps every user-facing path inside a single Next.js process. It scans
connections sorted by departure time, which is why `TransitGraph.connections`
must be sorted ascending by `departureTime`.

---

## Mobile-first is a requirement, not styling

This is a navigation app.

- The map is **full-bleed**. All controls live in a **draggable bottom sheet**
  with three detents — **peek ~15%** (origin/destination + primary CTA),
  **half ~50%** (route options), **full ~92%** (detail, alerts, sources).
  No top navigation.
- Primary actions sit in the **bottom 40%** of the viewport, for one-handed use.
- Minimum touch target **44×44 CSS px**. No hover-dependent interaction.
- Safe-area insets respected. No horizontal scroll at 375px.
- Installable PWA. Bahasa Malaysia / English toggle.

---

## Offline-first is the quality bar

The core network runs underground in tunnels where there is no signal.

- The full transit graph is cached after first load — **routing works in
  airplane mode**.
- Last-known disruption state is persisted with a visible
  **"as of HH:MM, N min ago"** timestamp. Stale data is never presented as live.
- Predicted arrival from schedule works offline; the risk overlay shows cached
  state with **reduced confidence, and says so**.
- Reconnect reconciles cached vs server state and surfaces what changed.

---

## Data sources

| Source | Notes |
|---|---|
| `api.data.gov.my` GTFS **static**, `category=rapid-rail-kl` | Official, free. 8 lines, 187 stops. Frequency-based. Committed as a fixture. |
| `api.data.gov.my` GTFS **realtime** vehicle positions | **Positions only** — no service alerts, no trip updates. And `rapid-rail-kl` has **no realtime feed at all**. This gap is the product's leverage. |
| `myrapid.com.my` media statements | The operator's own disruption notices. Behind Imperva bot protection; accessed via the Wayback Machine archive. This is our ground truth. |

---

## Commands

```bash
make install         # install dependencies
make graph           # build the transit graph from the committed GTFS fixture (offline)
make dev             # Next.js dev server — UI + API in one process
make test            # full vitest suite
make eval            # A1: precision / recall / median lead time
make replay          # A3: replay a historical disruption end-to-end
make verify-offline  # A4: assert zero live external network calls on the demo path
make verify-all      # every acceptance check in sequence
```

### Environment notes

Two npm quirks are pinned in the `Makefile`:

```bash
export npm_config_cache="$PWD/.npm-cache"   # the global cache may be root-owned
env -u npm_config_allow_scripts npm install # npm 11.19 rejects an env-provided allow-scripts
```

---

## Acceptance criteria

| # | Criterion | Proven by |
|---|---|---|
| A1 | `make eval` prints precision, recall, median lead time; exits non-zero below 50% coverage | `make eval` |
| A2 | A synthetic incident causes a different, higher-reliability route | `tests/routing/reroute.test.ts` |
| A3 | A historical disruption replays end-to-end with confidence at each hop | `make replay` |
| A4 | Zero live external network calls on the demo path | `make verify-offline` |
| A5 | Routing works offline on cached graph + cached signals | `tests/routing/offline.test.ts` |
| A6 | No horizontal scroll at 375px; every touch target ≥ 44px | `tests/ui/*` |
| A7 | Every agent has ≥ 1 custom tool that could not come from a template | `tests/signals/*`, `tests/risk/*` |

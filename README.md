# bkhome: bila sampai?

Klang Valley commuters find out the LRT is down only when they are already standing on the platform, and the official notice always comes later still. **bkhome** tells you before you leave — which segments are degraded, your P90 arrival window, and the route that actually gets you there.

Built for the tunnel: it keeps routing when your phone has no signal.

> The full story, the differentiation, and the roadmap are in [`pitch.md`](./pitch.md).

---

## Status

**Contracts frozen, modules landing.** The data contracts (`bob-transit/lib/contracts/`, v1.0.0) are final and no module may change them — that's what lets the ingest, verify, impact, and UI workstreams be built in parallel. The router, eval harness, and app shell are next.

`bob-transit` is the application directory. Everything below runs from there.

## Quickstart

```bash
cd bob-transit
npm install
npm run dev          # http://localhost:3000
```

No API keys, no paid tiers, no accounts. Everything runs against open data and cached fixtures.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Next.js dev server (UI + API routes). |
| `npm run build` / `npm start` | Production build and serve. |
| `npm test` | Vitest suite. |
| `npm run typecheck` | `tsc --noEmit`, strict. |
| `npm run graph:build` | Build the transit graph from GTFS static. |
| `npm run eval` | Precision, recall, and median lead time against the media-statement archive. |
| `npm run ingest` | Scheduled GTFS-R ingest worker (never on the request path). |
| `npm run replay` | Replay a historical disruption end-to-end. |
| `npm run verify:all` | Full acceptance suite. |

Some of these point at modules still being implemented. A script that doesn't run yet is not "done" — nothing in this repo is stubbed and called finished.

## Layout

```
bkhome/
├── pitch.md              # the pitch
├── README.md
├── .recon/               # reconnaissance: rapid-rail-kl GTFS static, probe results
└── bob-transit/          # the app
    └── lib/contracts/    # FROZEN — the interface everything else builds against
```

## The contracts

`bob-transit/lib/contracts/` is the shared interface between every module. Read these before writing code.

| File | Contents |
| --- | --- |
| `network.ts` | `Station`, `Line`, `SegmentId` — directional track segments, all times in local seconds-after-midnight. |
| `signal.ts` | `DisruptionSignal`, closed `IssueType` / `Severity` enums, source precedence. |
| `risk.ts` | `SegmentRisk`, `RiskOverlay`, and the risk-penalty signature. |
| `routing.ts` | `RouteQuery`, `Itinerary`, P90 arrival windows, reliability ranking. |
| `api.ts` | HTTP envelope shared by every API route, with staleness metadata. |

## Ground rules

- **One deployment.** Next.js serves UI and API. No separate backend process; the only exception is a scheduled ingest worker that never handles a user request.
- **Offline-first.** Routing works in airplane mode. Stale data is always labelled "as of HH:MM, N min ago" — never presented as live.
- **No paid APIs** on the critical path. MapLibre GL + OSM tiles.
- **Reliability first, duration second.** A faster route across a degraded segment is the worse recommendation.
- **Zero live external calls on the demo path.**

## Data sources

- [data.gov.my](https://api.data.gov.my/gtfs-static/prasarana?category=rapid-rail-kl) — official GTFS Static and GTFS Realtime (vehicle positions only).
- [myrapid.com.my](https://myrapid.com.my) — `KENYATAAN MEDIA` disruption statements, used as the ground-truth eval set.

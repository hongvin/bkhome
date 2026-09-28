# Subagent Brief — Klang Valley Transit Reliability

You are implementing **one module** of a mobile-first transit reliability app.
Read this whole file before writing code. It is the shared contract between all
parallel subagents.

Working directory: `/Users/hongvin/Documents/bkhome/bob-transit`

---

## 1. The product thesis (do not dilute this)

**Route to arrival PROBABILITY, not average duration.**

Given a disruption on a network segment, the app must:
1. estimate the probability a given segment is degraded,
2. report a **P90** arrival time rather than a mean, and
3. re-route around expected **risk**, not just expected time.

The routing is the delivery mechanism. **The reliability signal is the product.**
Results are sorted by **reliability first, duration second**. Never sort by raw speed.

Target users: Malaysian commuters on mobile broadband in the Klang Valley, many of
whom lose signal in MRT/LRT tunnels.

---

## 2. Environment — read this before running any command

The repo is already scaffolded, `npm install` has already run, and
`tsc --noEmit` + `next build` both pass on the baseline.

**npm quirks in this environment (you WILL hit these):**

```bash
# A globally-exported env var breaks npm 11.19 project installs. Always:
export npm_config_cache="$PWD/.npm-cache"   # global cache is root-owned
env -u npm_config_allow_scripts npm install ...
```

- Do **not** run bare `npm install` — it fails with `EALLOWSCRIPTS` and `EPERM`.
- Prefer **not installing anything new**. The dependency set is already chosen.
  If you genuinely need a package, install it with the command above and say so
  in your report.

**Useful commands** (run from the repo root):

```bash
./node_modules/.bin/tsc --noEmit          # typecheck
./node_modules/.bin/vitest run            # tests
./node_modules/.bin/tsx <script>.ts       # run a TS script
```

---

## 3. FROZEN CONTRACTS — do not modify

`lib/contracts/**` is **frozen and owned by the orchestrator**. It defines
`TransitGraph`, `Segment`, `DisruptionSignal`, `ConfidenceScore`, `RiskPenalty`,
`Itinerary`, `RouteAdvisory`, and the API envelope.

- **You must not edit anything in `lib/contracts/`.**
- If you need a contract change: **stop and report**. Do not guess, do not
  work around it with a local duplicate type.
- Import with `import type { X } from "@/lib/contracts"`.

---

## 4. File ownership — the rule that makes parallelism work

Each module owns a disjoint set of paths.

- **Never create or modify a file outside your ownership list.**
- If you believe you must, **stop and report** instead.
- Do not edit `package.json`, `Makefile`, `tsconfig.json`, `vitest.config.ts`,
  `next.config.ts`, or `app/globals.css` — the orchestrator owns those.
  If you need a script entry point, report the exact command to run instead.

---

## 5. Non-negotiable engineering rules

1. **No stubs. No TODOs. No "for brevity". No placeholder returns.**
   If a function is not implemented, the module is **not done**. A module that
   cannot be finished must be reported as blocked, not shipped half-built.
2. **Every module must work offline from cached fixtures with no network access.**
   Network calls are allowed only in clearly-marked, one-shot *acquisition*
   scripts whose output is committed as a fixture. Nothing on the demo request
   path may touch the network.
3. **Every module must be provable by ONE command.** Include the exact command
   and its real output in your report.
4. **Write tests.** Run them. Paste real output. Never write "tests pass" without
   the transcript.
5. **TypeScript strict mode is on.** No `any` unless genuinely unavoidable and
   commented. No `@ts-ignore` without a written reason.
6. **Do not add dependencies on modules owned by other subagents** unless that
   module is named in your "may depend on" list. Prefer depending on the frozen
   contracts.
7. **Determinism.** Anything the demo asserts must be reproducible: seeded
   randomness, fixed fixtures, no wall-clock dependence in tests. If you need
   "now", take it as a parameter.

---

## 6. Data you already have (committed fixtures — do not re-download)

| Path | What it is |
|---|---|
| `data/gtfs-static/rapid-rail-kl/*.txt` | **Real** GTFS static for the whole Klang Valley rail network (8 lines, 187 stops). Committed. Use this, never the network. |
| `eval/archive/manifest.json` | 323 archived myrapid.com.my PDFs (Wayback), with `wayback` download URLs |
| `eval/archive/media-statements.json` | 165 of those filtered to media-statement ("KENYATAAN MEDIA") PDFs |

### Facts about the GTFS feed you must handle

Verified by the orchestrator — treat as ground truth:

- The feed is **frequency-based**. `frequencies.txt` gives headways for all 48
  trip templates. **All 48 trip_ids DO have `stop_times.txt` rows** (1,122 rows
  total), and all three service patterns (`MonFri`, `Sat`, `Sun`) are covered.
  A correct implementation must still expand frequencies into concrete dated
  `Connection[]` — the templates are patterns, not departures.
- Lines: `AG` Ampang, `KJ` Kelana Jaya, `PH` Sri Petaling, `KGL` MRT Kajang,
  `PYL` MRT Putrajaya, `MR` Monorail, `BRT` Sunway, `SA` Shah Alam.
- **`route_id` is NOT consistent across files — this is a real join hazard.**
  You must join `stop_times` → `trips` on `trip_id` and take `route_id` from
  `trips.txt`. Never join on `stop_times.route_id`:

  | File | `route_id` values |
  |---|---|
  | `routes.txt` | `AG KJ PH KGL PYL MR BRT SA` |
  | `trips.txt` | `AG BRT KGL KJ MR PH PYL SA` (same set) |
  | `stops.txt` | `AG BRT KJ MR **MRT** PH PYL SA` — Kajang line is `MRT`, not `KGL` |
  | `stop_times.txt` | `**AGL BRT KGL KJL MRL PYL SAL SPL**` — long names, and `SPL` maps to `PH` |

  The mapping is: `AGL`→`AG`, `KJL`→`KJ`, `SPL`→`PH`, `MRL`→`MR`, `SAL`→`SA`,
  `MRT`→`KGL`. `KGL`, `PYL`, `BRT` are already consistent everywhere.
- `stops.txt` has a `geometry` column containing the literal string
  `[object Object]` — it is broken. Use `shapes.txt` for polylines instead.
- Interchanges are separate `stop_id`s per line at the same place (e.g.
  `KJ13`, `SP7` and `AG7` are all Masjid Jamek). Transfer logic must handle
  this by proximity/name, not by a shared id.
- Stops per line: `KJ` 37, `PYL` 36, `PH` 29, Kajang 29, `SA` 20, `AG` 18,
  `MR` 11, `BRT` 7.

---

## 7. Report format — required

When you finish, report exactly this:

1. **What you built** — files created, one line each.
2. **The verification command** and its **actual raw output** (paste it).
3. **Acceptance criteria** you were given, and pass/fail for each.
4. **Assumptions I should double-check** — be specific and honest.
5. **Anything you deviated from** in this brief, and why.

Report when your module lands. Do not wait for other subagents.

---

## 8. Stop conditions — report immediately, do not improvise

- A frozen contract needs to change.
- You need a file outside your ownership list.
- You need a credential or paid service.
- The fixture data does not support what you were asked to build.
- You are blocked for more than a short while on something you cannot resolve.

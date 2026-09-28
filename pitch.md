# bkhome: bila sampai?

**Transit routing that answers the only question that matters: *bila sampai? — when will I actually get there?***

Klang Valley rail commuters don't avoid the LRT and MRT because it's expensive or slow. They avoid it because they can't trust the ETA. `bkhome` routes you to an **arrival probability**, not an average duration — and it keeps working when you're underground with no signal.

---

## Title & description

**Title:** `bkhome: bila sampai?`

**Description:** Klang Valley commuters find out the LRT is down only when they are already standing on the platform, and the official notice always comes later still. `bkhome` tells you before you leave — which segments are degraded, your P90 arrival window, and the route that actually gets you there.

**Short tagline:** *Bila sampai? We answer with a probability, not a timetable.*

**Alternates, if you want a shorter token:**

| Title | Description |
| --- | --- |
| `bkhome: bila sampai?` | *(recommended)* The question every commuter actually asks, in the language they ask it in. |
| `bkhome:p90` | The thesis in one token: we quote the 90th-percentile arrival, not the mean. |
| `bkhome:reliable` | Klang Valley transit routing ranked by reliability, not raw speed. |

---

## 1. The problem

Malaysian public transport — LRT, MRT, Monorail, KTM, RapidKL buses — breaks down unpredictably, and the official channels report it late.

Google Maps and Waze will happily tell you the *scheduled* time. They have **no reliability signal at all**. So the commuter's real calculation isn't "is the train fast?" It's:

> *If I leave now, what are the odds I actually get to work on time — and is there a route with better odds?*

Nobody answers that question today.

Three facts make this a solvable problem right now:

1. **The official data is free and open.** [data.gov.my](https://api.data.gov.my/gtfs-static/prasarana?category=rapid-rail-kl) publishes official GTFS Static and GTFS Realtime feeds for Prasarana. No API key, no paid tier.
2. **The official realtime feed cannot tell you if service is broken.** It carries vehicle *positions only* — no service alerts, no trip updates ("in our pipeline for 2026"). A feed that shows where trains are is not a feed that tells you the line is down.
3. **`rapid-rail-kl` — the entire LRT/MRT/Monorail network — has no stable realtime feed at all.** Static schedule only. Rail ETAs are therefore pure arithmetic, and maximally wrong on exactly the day you need them.

Meanwhile, RapidKL publishes every disruption as a dated PDF "KENYATAAN MEDIA" on [myrapid.com.my](https://myrapid.com.my). Structured, timestamped, and **nobody is parsing them**.

---

## 2. The insight

The gap between *when a disruption becomes knowable* and *when the operator admits it* is the product.

An official media statement is high-precision and high-latency: it's confirmation, not early warning. A social post is low-precision and low-latency: one post is an anecdote. Fuse them, entity-resolve them to actual track segments, and you get something neither source has alone — **an early, calibrated probability that a specific segment is degraded**, with the operator's own notice arriving later as the ground truth that proves it.

That gives us a single defensible number: **median lead time**, in minutes, between our system flagging a disruption and the operator's own public notice.

---

## 3. What we built

A mobile-first, offline-first PWA that turns that signal into a route decision.

- **Route to probability.** Every itinerary is priced with a risk penalty proportional to `severity × confidence` per degraded segment — not a flat penalty, and not raw minutes.
- **P90 arrival windows, with the mean alongside.** The gap between them *is* the product. A route that says "28 min average, 41 min at P90" is telling you something Google Maps is hiding.
- **Sorted by reliability, not speed.** An itinerary that's 6 minutes faster but crosses a segment with >0.4 degradation confidence is the *worse* recommendation, and we say so.
- **Source Inspector.** One tap from every claim in the app to a plain-language "why do we believe this": signal → segment → confidence → route decision.
- **Disruption cards** that show what, where, severity, confidence, official-vs-distinct-social-author breakdown, and the `first_seen` → `operator_notified` delta.
- **A risk overlay** that colours segments by degradation probability *with confidence shown* — never a bare colour implying more certainty than we have.
- **Bahasa Malaysia / English** for all user-facing strings. Malaysia is multilingual, and the alert text is the product.

### It works in the tunnel

This is a hard quality bar, not a stretch goal. The core network runs underground where there is no signal.

- The full transit graph is cached after first load — **routing works in airplane mode**.
- Last-known disruption state persists locally with a visible **"as of HH:MM, N min ago"** staleness timestamp. We never present stale data as live.
- Offline, the risk overlay degrades to cached state with **reduced confidence, and says so in the UI**.
- On reconnect, cached and server state reconcile, and the app surfaces **what changed**.
- LCP < 2.5s on throttled 4G, because Malaysian mobile broadband is not fast and we assume the user is on the same data plan they stream WhatsApp video with.
- Installable PWA, 60-second cold start, minimum 44×44px touch targets, no hover-dependent interaction, primary actions in the bottom 40% of the viewport for one-handed use, draggable bottom sheet with peek/half/full detents. No top navigation.

---

## 4. How it works

**One Next.js deployment** serves UI and API. No separate backend process — a second server is a demo-day failure mode. The only out-of-process component is a scheduled ingest worker that never touches a user request.

```
  GTFS Static (rail) ──► Transit graph ──► CSA router ──┐
                                                         │
  GTFS-R positions ──┐                                   ▼
  Media-statement PDFs ──► INGEST ──► VERIFY ──► IMPACT ──► Advisory
  Operator + community ──┘   │          │          │      (P90 + reliability
                             │          │          │       + risk penalties)
                             └──────────┴──────────┘
                          DisruptionSignal, confidence at every hop
```

| Agent | Job | Its custom tool |
| --- | --- | --- |
| **Ingest** | Polls heterogeneous sources, emits a normalized `DisruptionSignal`. | PDF media-statement parser that turns `KENYATAAN MEDIA` documents into structured incidents. |
| **Verify** | Entity-resolves mentions to network segments, reconciles conflicting sources, assigns calibrated confidence. | Segment resolver + source-precedence fusion with distinct-author counting. |
| **Impact** | Re-routes under risk penalty, emits an arrival-probability advisory. | Severity × confidence risk penalty feeding a reliability-first re-rank. |

The Verifier is deliberately conservative: **under-calling an incident is cheaper than inventing one.** Silence is a valid answer. It resolves locations to specific directional segments, rejects reports referencing events outside the current window, and scales social evidence by *distinct authors* — never by repost volume.

The data contracts are frozen (`bob-transit/lib/contracts/`, v1.0.0) precisely so these three agents can be built in parallel without blocking each other.

---

## 5. Why not just use LRTDown.my?

[LRTDown.my](https://lrtdown.my) (and [mrtdown.org](https://www.mrtdown.org)) are good, and we're glad they exist — they proved Malaysian commuters will trust a non-official signal. We're building the wider thing, and the difference is architectural, not cosmetic.

**They answer "is my line down right now?"** It's a status board: community reports aggregated by unique devices, plus operator statements from X, rendered per line and per station, cached offline. That's genuinely useful, and it's a solved shape.

**We answer "which route should I take, and what are my odds of arriving?"** That's a routing decision, and it needs a different evidence base:

1. **Not community-report-only.** Their primary signal is rider reports. We treat community reports as **one input among several** — alongside official GTFS static, GTFS realtime vehicle positions, operator media-statement PDFs, and operator social. A community board needs volume to be useful; a fused model can be right on a quiet day too.
2. **Not human-read.** A status board is read by a person, who then decides. Our output is a **machine-computed arrival probability** applied to the router, so the risk actually changes which route you're given.
3. **Not line-level.** "Kelana Jaya is disrupted" doesn't tell you whether *your* segment is affected. We resolve to directional track segments, because a southbound fault need not affect northbound.
4. **Not a colour.** A colour implies certainty. We ship **confidence with the colour**, and a calibrated P90 rather than a vibe.
5. **Not a status page.** There's no itinerary, no transfer logic, no risk-penalised re-ranking, no source inspector, no lead-time measurement.

We'd rather credit and interoperate than compete on the same axis: a community signal is a first-class *input* to our verifier, and the future plan below includes ingesting it explicitly.

---

## 6. The number that matters

The myrapid.com.my media-statement archive is our **ground-truth evaluation set, for free**. We treat building the eval harness as a first-class deliverable, not a nice-to-have, because it's the only thing that makes every other claim defensible.

`npm run eval` prints, reproducibly:

- **precision and recall** of the signal pipeline against official notices, and
- **median lead time** — minutes between our agent flagging a disruption and the operator's own public notice.

That single number is our feasibility proof, our real-world-relevance proof, and our answer to *"why not just use Google Maps?"* — all at once. It exits non-zero below 50% coverage, so the claim can't quietly rot.

**Definition of done, in testable form:**

| # | Criterion |
| --- | --- |
| A1 | `npm run eval` prints precision, recall, median lead time; non-zero exit below 50% coverage. |
| A2 | Injecting a synthetic incident on a segment makes the router return a different, higher-reliability route. Asserted by a test. |
| A3 | A historical disruption replays end-to-end with a confidence value at each hop. |
| A4 | **Zero live external network calls on the demo path.** A test asserts this. |
| A5 | Routing works offline on cached graph + cached signals. |
| A6 | No horizontal scroll at 375px; every touch target ≥ 44px. |
| A7 | Every agent has ≥1 custom tool that could not have come from a template. |

---

## 7. Scope discipline

We are deliberately not building these, and we're saying so out loud:

- **No carpool / ride-sharing matching.** Network effects and trust/safety. Different product.
- **No native mobile.** Web/PWA only.
- **No coverage outside the Klang Valley.** The data exists for Peninsular Malaysia. The demo dies in geography if we reach for it.
- **No paid API on the critical path.** MapLibre GL + OSM tiles. No Google Maps SDK, no Mapbox, no paid LLM tier, no API keys we don't have.
- **Social ingest is last and fully optional**, backed by a pre-seeded captured corpus so no live network call sits on the demo path.

**If we run behind, we cut in this order** — and say so on camera: Bahasa/English toggle → the map risk overlay → the reliability badge (keep P90) → Bahasa text. **Never cut:** the eval harness, offline routing, the P90 display, the Source Inspector, the lead-time number, or **sorting by reliability instead of duration** — that last one is the entire product thesis in a single line.

---

## 8. Future plan

**Near term — finish the thesis.**
1. **Community signals as an explicit ingest class.** Wire rider reports (our own, plus opt-in ingestion from community trackers like LRTDown/MRTDown, with attribution) into the Verifier as a distinct source class alongside official and social — so the widest possible evidence base feeds one calibrated probability.
2. **GTFS-R trip updates the moment they land.** Prasarana says 2026. When service alerts and trip updates appear, the Verifier's job shifts from inference to reconciliation, and lead time should collapse.
3. **Calibration against real outcomes.** Turn the eval harness into a standing regression suite that runs on every new media statement, so precision/recall and lead time are tracked over time, not measured once.

**Next — widen the network.**
4. **Bus network on-ramp.** RapidKL bus GTFS is ~2% incomplete in `stop_times.txt`, so we scoped rail-first on purpose. With the graph contract already generic, buses become a data-quality problem, not an architecture problem.
5. **KTM + MRT feeder integration**, then cross-border and intercity, on the same contracts.
6. **Multi-modal fallback legs** — when no safe rail alternative exists, offer a ground-transport option with its own realistic estimate, rather than pretending the choice is binary.

**Later — make the reliability signal a public good.**
7. **A public reliability API.** Per-segment degradation probability and P90 arrival, queryable. Reliability data shouldn't be trapped inside one app — including ours.
8. **Personal reliability.** "Will *I* make my 9am?" — learning a rider's transfer tolerance and walking speed, and quoting odds against their actual deadline.
9. **Push alerts that respect the tunnel.** Offline-queued notifications that fire on reconnect with the staleness delta intact.
10. **Predictive degradation.** Move from detecting incidents to anticipating them — recurring fault patterns by segment, weather, and time of day.
11. **Other Malaysian cities**, then the same contracts for any GTFS-publishing operator anywhere. The problem is not unique to Kuala Lumpur; the trust gap is universal.

---

## 9. The demo

A real phone, a cold start, and airplane mode in the middle of it — because the tunnel is the whole point. If only one thing works, it's this: **inject a disruption, watch the router change its recommendation, and show the confidence value at every hop from signal to advisory.**

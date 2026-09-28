# 3-Minute Demo Script

Written before the build, per the planning brief. Recorded from a **cold start,
on a real phone**.

> If only one thing works, it is: **the P90 arrival window and the lead-time
> number.** Everything else is supporting evidence.

---

## The one-line thesis

> "Google Maps tells you when the train is supposed to arrive. We tell you how
> likely it is to actually get you there — and we tell you before the operator
> does."

---

## Beat sheet

### 0:00 — The problem, on a real phone, offline (20s)

Hold the phone. **Airplane mode on.**

> "This is the Kelana Jaya line. I'm underground. No signal. Every other
> navigation app is now a blank screen."

Open the app. It loads. The map is blank — expected — but the routing still works.

> "Our transit graph is cached on the device. Routing works in airplane mode.
> That's not a nice-to-have; the core network is underground."

### 0:20 — Route to probability, not duration (40s)

Enter origin/destination. Hit **Go**. Results appear **sorted by reliability, not
speed**.

Point at the top card:

> "This is not the fastest option. It's 4 minutes slower. But look at the P90 —
> the fast one arrives anywhere between 22 and 51 minutes, because it crosses a
> segment we believe is degraded. The one we're recommending arrives in 27 to
> 31. We'd rather you arrive."

Show the mean next to the P90.

> "The gap between the mean and the P90 is the product. That's the uncertainty
> everyone else hides from you."

### 1:00 — Why we believe it (40s)

Tap **the claim** → **Source Inspector**.

> "Every claim in this app is one tap from its evidence."

Show the trace: signal → segment → confidence → route decision, with the
confidence value at each hop.

Show the **disruption card**:

> "Three distinct social authors flagged this at 07:41. The operator's own media
> statement landed at 08:14. **Thirty-three minutes.** That delta is the product."

Point at the source breakdown: official vs distinct social authors.

> "Reposts don't count. Only distinct authors. One post is an anecdote; five
> independent people on one segment is evidence."

### 1:40 — Turn the signal off and watch the route change (25s)

Airplane mode **off**. Reconnect reconciles.

> "We just came back online. Here's what changed while we were underground."

Inject the synthetic incident (or let the live one resolve).

> "Watch the ranking."

The recommendation **changes** — the fast-but-risky route drops.

> "That's acceptance criterion A2, asserted in a test: a synthetic incident on a
> segment makes the router return a different, higher-reliability route."

### 2:05 — The hard number (35s)

Show `make eval` output on screen.

> "We evaluate against the operator's own media-statement archive — 165
> documents, scraped from the Wayback Machine because myrapid.com.my blocks
> scrapers. It's free, real-world ground truth that nobody else is parsing."

Read the numbers out loud: **precision, recall, median lead time, coverage.**

> "Median lead time is the number that answers 'why not just use Google Maps'.
> We flag it, on average, N minutes before the operator tells you."

### 2:40 — Close (20s)

> "One Next.js deployment serves the UI and the API. No API keys, no paid tiers,
> no Google Maps SDK — MapLibre and OSM. The transit router is 200 lines of
> Connection Scan Algorithm in TypeScript against the official GTFS static feed.
>
> The official realtime feed carries vehicle positions only — no service alerts.
> And the entire rail network has no realtime feed at all. That's the gap.
> We filled it with a reliability signal."

---

## Cold-start checklist (rehearse this)

- [ ] Phone charged, notifications off, screen rotation locked
- [ ] App installed to home screen (standalone display, not a browser tab)
- [ ] Transit graph cached **before** going on stage
- [ ] Airplane mode verified working *before* recording
- [ ] `make eval` output pre-rendered in a terminal at readable font size
- [ ] Synthetic incident injection rehearsed — know the exact command
- [ ] Server running locally; **no live external calls on the demo path** (`make verify-offline`)

## If something breaks

Say it out loud and cut, in this order:

1. Bahasa/English toggle (keep the strings, drop the toggle)
2. Risk overlay map layer
3. Reliability badge on route cards (keep P90, drop the badge)
4. ~~Sort by reliability instead of duration~~ — **never cut this.** It is the
   product thesis in a single line.
5. Bahasa text itself (English only is fine)

**Never cut:** the eval harness, offline routing, the P90 display, the source
inspector, or the lead-time number. Those are the submission.

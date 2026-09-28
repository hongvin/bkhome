# Confidence calibration — the table, and why it is this table

`calibrationVersion: s3-calib-1.0.0` (constant `CALIBRATION_VERSION` in `calibration.ts`).

A score is only comparable to another score with the same `calibrationVersion`.
The function is pure: same inputs, same output, no clock, no randomness, no model.

---

## 0. The asymmetry that drives every constant

> A false positive sends thousands of commuters onto worse routes.
> A false negative leaves them stranded.

Those are not symmetric costs, so the calibration is **not** symmetric. Where the
evidence is thin, the answer is a *lower* number with a *stated reason*, never a
rounded-up one. When nothing clears `REPORTABLE_CONFIDENCE = 0.30`, the pipeline
returns an empty signal list. **Silence is a correct output.**

---

## 1. Evidence is combined as independent channels (noisy-OR)

```
social    = SOCIAL_AUTHOR_TABLE[distinctAuthors] × socialQuality × recency
official  = 0.90 × officialQuality
realtime  = min(0.15, 0.05 × observations) × realtimeQuality

combined  = 1 − (1 − social)(1 − official)(1 − realtime)
value     = combined × unresolvedMult × officialDenialMult × offlineMult
            (hard-capped at 0.45 when unresolved)
```

Noisy-OR is the right combiner here because the channels are *independent evidence
paths*: a confirmed operator statement and three independent witnesses should
reinforce each other, and neither should be able to push the total past 1. It also
gives the required behaviour for free — **adding evidence can only ever raise the
score**, which is exactly the monotonicity property the brief demands.

---

## 2. The social table — distinct authors, never repost volume

| distinct independent authors | social channel | band alone |
|---|---|---|
| 0 | 0.00 | — (no evidence) |
| 1 | 0.18 | VERY_LOW → **LOW** |
| 2 | 0.32 | LOW |
| 3 | **0.45** | **MODERATE** |
| 4 | 0.53 | MODERATE |
| 5 | 0.58 | MODERATE |
| 6+ | 0.60 | MODERATE (saturates) |

Why these numbers:

- **1 author = anecdote.** It is evidence that *someone said something*, not that
  a train stopped. A single post is deliberately below `REPORTABLE_CONFIDENCE`,
  so a lone social post produces no signal at all.
- **3 authors = the threshold where the boring explanation loses.** With three
  independent people, on one segment, inside one window, "three unrelated bad
  mornings" becomes less likely than "the segment is degraded". This is why the
  brief's "3+ distinct social authors → moderate" lands at 0.45.
- **Saturation at 0.60 is a hard product decision.** Social evidence alone must
  never reach the HIGH band (≥ 0.65). A rumour, a retweeted joke, a copied
  complaint format or one misread platform sign can all produce a crowd. Only an
  official source may cross that line.
- The table is **monotone non-decreasing by construction**, and the channel is
  multiplied by quality factors that are themselves ≤ 1, so no input can make
  more authors score lower. Tested in `tests/signals/calibration.test.ts`.

**Reposts never enter this count.** The author counter is fed
`distinctAuthors`, computed in `lib/signals/dedupe.ts` over
`originalAuthorId ?? authorId`. A, B and C all reposting A's post is **one**
author. See `repostsDoNotInflate` in the tests.

---

## 3. Source precedence

| source class | precision | latency | what we trust it for |
|---|---|---|---|
| `OFFICIAL_STATEMENT` | high | high | **content, fully** — this is confirmation, not early warning. Base 0.90. |
| `OFFICIAL_REALTIME` | medium | low | **position, not health.** A stalled vehicle is weak evidence; *the absence of a vehicle is not evidence of a fault at all* — zero observations contributes zero, never a penalty. Cap 0.15. |
| `SOCIAL` | low | very low | early warning only, scaled by **distinct authors**, capped at 0.60. |
| `INTERNAL` | — | — | not scored as evidence; carried as context/annotation only. |

The product's value is the **delta** between the low-latency social channel and the
high-latency official one, which is why they are separate channels rather than one
weighted soup.

### Worked combinations

| evidence | value | band |
|---|---|---|
| 1 social author | 0.180 | LOW |
| 2 social authors | 0.320 | LOW |
| 3 social authors | 0.450 | MODERATE |
| 6 social authors | 0.600 | MODERATE |
| official statement alone | 0.900 | VERY_HIGH |
| 3 social authors **+** official statement | **0.945** | VERY_HIGH |
| 1 social author + official statement | 0.918 | VERY_HIGH |
| 2 realtime observations alone | 0.100 | VERY_LOW |
| 3 realtime observations alone (cap) | 0.150 | VERY_LOW |
| 3 social authors, one of them sarcastic | ≪ 0.45 | drops below reportable |

**"Official confirmation raises it sharply"** is satisfied by construction: 1
social author alone is 0.180; the same author plus one official statement is
0.918 — a 5× jump. Tested in `officialConfirmationRaisesSharply`.

---

## 4. Multipliers, and why each exists

| factor | multiplier | reason |
|---|---|---|
| `location_resolution` (unresolved) | ×0.80, **hard cap 0.45** | We do not know *where*. A high-confidence claim with no segment is unusable and dangerous; it can never be HIGH. |
| `official_denial` | ×0.25 | An official "service normal" is high-precision. When the operator says nothing is wrong, social noise is heavily discounted. |
| `offline_cache` | ×0.85 | Contract requires the UI to reduce displayed confidence for cached state; the number itself carries the reduction so the UI cannot forget it. |
| `recency` | linear decay to ×0.15 floor over 3 windows | Stale evidence is weak evidence. Fresh evidence inside the window is untouched. |

---

## 5. Attribution is real (leave-one-out)

Every `ConfidenceFactor.contribution` is computed as:

```
contribution(f) = value(all factors) − value(all factors with f neutralised)
```

So a negative contribution means "removing this factor would have raised the
score" — i.e. it is a genuine penalty — and a positive contribution means it
genuinely helped. `weight` is the factor's own magnitude (a count, or a
multiplier). This is why the trace in `tests/signals/pipeline.test.ts` can show a
sarcastic post *losing* confidence between hops rather than merely being labelled.

---

## 6. Reporting threshold

`REPORTABLE_CONFIDENCE = 0.30` (band LOW's upper half). Below it the verifier emits
nothing. A single social post (0.18) and a sarcastic post (≈0.01) are therefore
both silent — which is the correct, and cheapest, answer.

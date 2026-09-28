# Eval method — how the A1 numbers are produced

`make eval` prints **precision**, **recall**, **median lead time** and **coverage**
for the reliability signal pipeline against the archived myrapid.com.my media
statements, and exits non-zero when coverage falls below 50%.

Everything below is reproducible: no wall clock, no `Math.random`, no network.

## Measured results (this corpus, reference pipeline)

| Metric | Statement level | Event level |
|---|---|---|
| Precision | **80.4%** (37 TP / 46 emitted) | 73.5% |
| Recall | **90.2%** (37 / 41) | 89.3% (25 / 28) |
| Coverage | **90.2%** (37 / 41) | 89.3% |
| F1 | 0.851 | 0.806 |
| **Median lead time** | **218.4 min** (n = 16) | — |

Companion, assumption-free figure: **median operator latency 222.4 min** — the
gap between when the disruption started and when Prasarana published. That is the
ceiling any pipeline could achieve on this archive.

All 9 false positives come from the 12 injected decoy clusters; **no** signal
derived from a labelled incident failed to match. The 4 remaining false negatives
are explained per-signal by `--explain`.

---

## 1. Corpus

| Stage | File | Committed? |
|---|---|---|
| Raw PDFs (Wayback) | `eval/archive/*.pdf` | no — gitignored, 44 MB |
| Manifest | `eval/archive/media-statements.json` | yes |
| Extracted text | `eval/out/raw-text.json` | no — gitignored |
| **Labelled ground truth** | `data/incidents/labelled.json` | **yes** |
| **Synthetic evidence** | `data/incidents/evidence-corpus.json` | **yes** |
| Hand-review corrections | `eval/overrides.json` | yes |

### Acquisition (the only networked step)

```bash
./node_modules/.bin/tsx eval/fetch-archive.ts            # 165/165 PDFs, ~45 s
./node_modules/.bin/tsx eval/fetch-archive.ts --all      # all 323 manifest entries
```

`myrapid.com.my` is behind Imperva bot protection and answers direct requests
with a 302 redirect loop, so the PDFs come from the Wayback Machine's raw-bytes
URL form (`https://web.archive.org/web/<ts>id_/<original>`). The script is
idempotent: a file already present with a `%PDF-` magic header is skipped.

### Labelling (offline)

```bash
./node_modules/.bin/tsx eval/build-labels.ts --reextract   # re-read every PDF
./node_modules/.bin/tsx eval/build-labels.ts --review      # audit table
./node_modules/.bin/tsx eval/build-corpus.ts               # rebuild evidence
```

Text is extracted with `pdfjs-dist` (legacy build, Node). Every rule in
`eval/lib/lexicon.ts` and `eval/lib/parse.ts` was written by reading the actual
corpus, not guessed; `tests/eval/fixtures/` pins the important phrasing.

**`publishedAt` = the PDF `CreationDate`.** It is present on all 165 documents.
The body dateline ("KUALA LUMPUR, 27 Januari 2023") agrees with it on 124/138
documents and differs by one day on 13; the PDF timestamp is used because it
carries a clock time.

### Document taxonomy

| Kind | Count | Meaning |
|---|---|---|
| `INCIDENT` | **41** | the operator reports an **unplanned** event that degraded, halted or closed a **named rail/BRT line or station**. Follow-up updates and restoration notices for such an event count. |
| `PLANNED_SERVICE_CHANGE` | 2 | works, tests, migrations or closures announced in advance |
| `NON_INCIDENT` | 119 | corporate, campaign, event, tender, policy, bus-route changes, retrospective investigations, non-transit fires |
| `UNREADABLE` | 0 | — |
| duplicate files merged | 3 | Wayback re-uploads (`__dupN__`) and `-Ver2` / `_FINAL-1` revisions |

Every one of the 165 documents was read and the rule output checked against it.
`eval/overrides.json` holds **34** entries, each with a written reason: they
correct a wrong classification, restate an issue type, or link a follow-up
statement to the event it belongs to. That file *is* the hand review; the split
is reported rather than hidden.

Of the 41 incident statements, **28 are distinct real-world events** — the rest
are follow-ups, bus-bridging updates and restoration notices for an event already
counted. `sameEventAs` in `eval/overrides.json` records the grouping, and the
report prints event-level numbers alongside the statement-level ones.

---

## 2. Onset, publication, and lead time — the honest version

This is the part that most needs scrutiny, so it is stated in full.

The archive is **the operator's own notice**. It contains no tweets, no PULSE
observations, no station PA logs. There is therefore no `firstSeenAt` in the
data, and without `firstSeenAt` there is no lead time.

Three timestamps are in play:

| Symbol | Meaning | Source | Real or modelled? |
|---|---|---|---|
| `onsetAt` | when the disruption began | the statement's own words, e.g. *"Bekalan kuasa terputus pada pukul 8.36 pagi"* | **real, document-derived** |
| `publishedAt` | when the operator told the public | the PDF `CreationDate` | **real, document-derived** |
| `firstSeenAt` | when our pipeline first saw evidence | `onsetAt + delta` | **MODELLED** |

### `onsetAt`

`estimateOnset` takes the earliest **onset-role** clock time in the statement
body. A clock time is onset-role when its surrounding clause carries
`berlaku` / `dikesan` / `dilaporkan` / `terputus` / `terhenti` / `bermula` /
`sejak` / `kejadian` / `insiden` …, and restore-role when it carries
`pulih` / `dibuka semula` / `selesai`, and schedule-role when it carries
`waktu operasi` / `setiap hari`. Without that split, *"Perkhidmatan pulih
sepenuhnya pada jam 1.26 petang"* would be read as the onset.

The clock time is anchored to the nearest preceding explicit date, to `semalam`
(previous day) or to `pagi tadi` / `petang tadi` (same day), and otherwise to the
dateline. An anchor later than publication is rejected — a statement cannot
describe a day that has not happened.

Basis achieved over the 41 incidents:

| Basis | Count | Precision of the anchor |
|---|---|---|
| `explicit_time` — a clock time in the body | 21 | to the minute |
| `date_only` — an explicit date, no clock time | 4 | to the day |
| `dateline_only` — nothing usable | 16 | to the publication day |

**16 of 41 incidents have no usable onset clock time.** Their lead time is not
computed; they still count for precision, recall and coverage.

### `firstSeenAt` and `delta` — THE ASSUMPTION

`delta` is the modelled delay between a disruption starting and the first public
observation reaching our ingest. It is drawn as a **uniform integer in [2, 9]
minutes**, seeded by `sha256(incident.contentId)` via mulberry32
(`eval/lib/rng.ts`), so it is identical on every run.

The evidence corpus (`eval/build-corpus.ts`) then places:

| Item | Source class | Time | Probability |
|---|---|---|---|
| e0 | `SOCIAL` | onset + delta | always |
| e1 | `SOCIAL` | onset + delta + 4 min | by severity |
| e2 | `SOCIAL` | onset + delta + 11 min | by severity |
| e3 | `SOCIAL` | onset + delta + 19 min | by severity |
| e4 | `OFFICIAL_REALTIME` | onset + delta + 31 min | by severity |
| repost | `SOCIAL`, identical text | onset + delta + 2 min | 0.5 |

Follow-up probabilities by severity (SEVERE `[.9,.8,.65,.55]`, MAJOR
`[.75,.6,.4,.4]`, MINOR `[.5,.3,.15,.2]`, INFO `[.4,.2,.1,.15]`) encode the
belief that people post about stranded trains far more than about short delays.
Reposts share a `contentHash` with e0 and must be deduped by ingest — they must
**not** count as an extra corroborating author.

**This corpus is a model, not a measurement.** The lead time it produces is a
model output. It is reported next to the assumption-free figure so the reader can
see both.

### The formula

```
leadTime = publishedAt - firstSeenAt = operatorLatency - delta
operatorLatency = publishedAt - onsetAt          <- assumption-free, document-derived
```

`operatorLatency` is a real property of the operator: how long Prasarana took to
say something publicly. It is also the **ceiling** on lead time, because no
pipeline can observe a disruption before it starts. The report prints both.

Lead time is only computed for incidents that are:

* `onsetBasis === "explicit_time"` (a clock time exists), and
* `0 <= operatorLatency <= 24 h` (a same-cycle report, not a retrospective), and
* not `onsetAfterPublication` (a contradiction in the source document), and
* matched to an emitted signal.

That leaves **16 incidents** in the median.

---

## 3. The pipeline

S3 owns the real Ingest/Verify agents under `lib/agents/**`. The eval does not
import them and does not wait for them. `eval/lib/pipeline.ts` defines a narrow
interface —

```ts
interface EvalPipeline {
  ingest(evidence, index): EvalCandidate[];
  verify(candidates, options): EvalSignal[];
  run(evidence, options?): EvalSignal[];
}
```

— and ships a deterministic reference implementation. Swapping in the real
agents means writing one adapter that satisfies `EvalPipeline`; the metrics and
the report do not change.

The reference implementation is not a stub: it runs the real Malay parser
(`eval/lib/parse.ts`) over the raw evidence text to recover lines, stations and
issue type, so a parser regression shows up as a recall regression.

* **ingest** — dedupe by `contentHash`, parse each item, then greedily cluster
  items that share a line and overlap on station within a 120-minute window.
* **verify** — confidence is a weighted sum:
  `0.45 * min(distinctAuthors,3)/3 + 0.20 * realtime + 0.20 * locationSpecificity
  + 0.15 * issueSpecificity`.
  A candidate is emitted when it is corroborated (≥ 2 distinct authors, or any
  official realtime/statement source) **and** confidence ≥ 0.4.

12 **decoy** clusters — plausible false-alarm chatter with no corresponding
operator statement — are injected so precision is not trivially 1.0.

---

## 4. Metrics — exact definitions

Let `S` be emitted signals and `I` the labelled incidents.

**Full match** (drives precision and recall): signal and incident share a line,
have the **same** `issueType`, share a station when both name one, and
`|signal.firstSeenAt − incident.onsetAt| ≤ 360 min`. Assignment is greedy
one-to-one, closest first, deterministic.

**Coverage match**: signal and incident share a line and fall inside the same
360-minute window. Issue type and station are **not** required. Line-only
matching was tried first and was useless — with 8 lines the 12 decoys covered
every line and coverage sat at a meaningless 100%.

```
precision = TP / (TP + FP)          over emitted signals
recall    = TP / (TP + FN)          over labelled incidents
coverage  = |{i in I : some signal covers i}| / |I|
```

**Event level** collapses statements that share an event (via `sameEventAs`) to
one unit, attributed to the event's first statement. A signal matching any
statement of an event counts for that event; false positives are unchanged.

---

## 5. Reproducing

```bash
make eval                                        # the report
./node_modules/.bin/tsx eval/run-eval.ts --json  # machine-readable
./node_modules/.bin/tsx eval/run-eval.ts --explain
./node_modules/.bin/vitest run tests/eval
./node_modules/.bin/tsc --noEmit
```

---

## 6. Known limitations — do not quote these numbers without them

1. **Lead time is a model output.** It rests entirely on `delta ∈ [2, 9] min`.
   The assumption-free companion number is `median operator latency`. Change
   `FIRST_OBSERVATION_DELTA` in `eval/lib/corpus.ts` and re-run to see the
   sensitivity.
2. **The evidence corpus is synthetic.** It is not observed social data and
   cannot validate real-world precision or recall.
3. **16 of 41 incidents have no onset clock time**, so they cannot enter the
   lead-time sample. Their recall contribution is unaffected.
4. **Recall is measured against statements, not newsroom truth.** A statement
   reporting an event the operator never publicly acknowledged elsewhere does not
   exist in this archive, so the ground truth is bounded by what Prasarana chose
   to publish.
5. **One incident has a self-contradictory timestamp.** The 11 Dec 2024 KGL
   restoration notice states an onset at 20:06 and a restoration at 22:08, while
   its PDF `CreationDate` is 14:44 the same day. It is excluded from the
   lead-time sample and flagged as `onsetAfterPublication` rather than silently
   corrected.
6. **The labelled set is a judgement call.** 41 statements, 28 events. The
   taxonomy is defined in §1 and every override carries a written reason; a
   reviewer who disagrees with a specific document can change one entry in
   `eval/overrides.json` and re-run.

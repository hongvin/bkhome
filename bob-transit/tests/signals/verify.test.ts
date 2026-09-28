import { describe, expect, it } from "vitest";

import { ISSUE_TYPES, SEVERITIES } from "@/lib/contracts";
import type { DisruptionSignal } from "@/lib/contracts";
import { runVerifyAgent } from "@/lib/agents/verify/agent";
import { readEvidenceSummary } from "@/lib/signals/lifecycle";
import { SignalStore } from "@/lib/signals/store";
import type { RawSourceRecord } from "@/lib/signals/types";

const NOW = "2024-03-05T09:00:00+08:00";

function social(id: string, authorId: string, text: string, publishedAt = "2024-03-05T08:20:00+08:00"): RawSourceRecord {
  return {
    id,
    sourceClass: "SOCIAL",
    authorId,
    authorHandle: `@${authorId}`,
    text,
    publishedAt,
    retrievedAt: publishedAt,
    language: "ms",
  };
}

function verify(records: RawSourceRecord[], now = NOW) {
  return runVerifyAgent({ records, now });
}

describe("silence is a valid answer", () => {
  it("returns an empty signal list for empty input", () => {
    const result = verify([]);
    expect(result.signals).toEqual([]);
    expect(result.rejected).toEqual([]);
    expect(result.candidates).toEqual([]);
  });

  it("returns an empty signal list for a single anecdote", () => {
    const result = verify([social("a", "tw:a", "Lif rosak di stesen KLCC, kena naik tangga.")]);
    expect(result.signals).toEqual([]);
    expect(result.rejected.length).toBe(1);
    expect(result.rejected[0].reason).toMatch(/below the reportable threshold/);
  });

  it("returns an empty signal list when realtime telemetry is the only evidence", () => {
    const result = verify([
      {
        id: "rt1",
        sourceClass: "OFFICIAL_REALTIME",
        observation: "VEHICLE_STALLED",
        observedLineId: "KJ",
        observedStationId: "KJ10",
        text: "Telemetry: trainset stationary at KLCC for 240s.",
        publishedAt: "2024-03-05T08:30:00+08:00",
        retrievedAt: "2024-03-05T08:30:05+08:00",
      },
      {
        id: "rt2",
        sourceClass: "OFFICIAL_REALTIME",
        observation: "VEHICLE_ABSENT",
        observedLineId: "KJ",
        observedStationId: "KJ8",
        text: "Telemetry: no train observed at Damai for 6 minutes.",
        publishedAt: "2024-03-05T08:31:00+08:00",
        retrievedAt: "2024-03-05T08:31:05+08:00",
      },
    ]);
    expect(result.signals).toEqual([]);
  });

  it("does not treat the absence of a vehicle as evidence of a fault", () => {
    const onlyAbsence = verify([
      {
        id: "rt1",
        sourceClass: "OFFICIAL_REALTIME",
        observation: "VEHICLE_ABSENT",
        observedLineId: "KJ",
        observedStationId: "KJ8",
        text: "Telemetry: no train observed at Damai.",
        publishedAt: "2024-03-05T08:30:00+08:00",
        retrievedAt: "2024-03-05T08:30:05+08:00",
      },
    ]);
    expect(onlyAbsence.signals).toEqual([]);
    expect(onlyAbsence.rejected[0].confidence).toBe(0);
  });
});

describe("three independent witnesses on one segment", () => {
  const records = [
    social("a", "tw:a", "LRT Kelana Jaya tergendala. Tren berhenti antara KLCC dan Ampang Park, 10 minit.", "2024-03-05T08:05:00+08:00"),
    social("b", "tw:b", "Stesen Ampang Park penuh sesak. Sistem isyarat rosak, tren tak bergerak.", "2024-03-05T08:08:00+08:00"),
    social("c", "tw:c", "Signal fault kat LRT Kelana Jaya. Train stuck between KLCC and Ampang Park.", "2024-03-05T08:12:00+08:00"),
  ];

  it("produces exactly one resolved signal", () => {
    const result = verify(records);
    expect(result.signals.length).toBe(1);
    const signal = result.signals[0];
    expect(signal.resolution).toBe("RESOLVED");
    expect(signal.segmentIds).toEqual(["KJ:KJ10->KJ9", "KJ:KJ9->KJ10"]);
    expect(signal.lineIds).toEqual(["KJ"]);
    expect(signal.issueType).toBe("SIGNAL_FAULT");
    expect(signal.severity).toBe("MAJOR");
    expect(signal.status).toBe("REPORTED");
    expect(signal.corroboratingSources).toEqual({
      official: 0,
      socialDistinctAuthors: 3,
      realtimeObservations: 0,
    });
    expect(signal.unresolvedCandidates).toBeUndefined();
  });

  it("emits a contract-shaped signal with both provenance hops", () => {
    const signal = verify(records).signals[0];
    expect(ISSUE_TYPES).toContain(signal.issueType);
    expect(SEVERITIES).toContain(signal.severity);
    expect(signal.confidence.value).toBeGreaterThan(0);
    expect(signal.confidence.value).toBeLessThanOrEqual(1);
    expect(signal.confidence.factors.length).toBeGreaterThan(0);
    expect(signal.provenance.map((h) => h.hop)).toEqual(["INGEST", "VERIFY"]);
    for (const hop of signal.provenance) {
      expect(hop.confidence).toBeGreaterThanOrEqual(0);
      expect(hop.confidence).toBeLessThanOrEqual(1);
      expect(hop.summary.length).toBeGreaterThan(0);
    }
    expect(signal.operatorNotifiedAt).toBeNull();
    expect(signal.leadTimeMinutes).toBeNull();
    expect(signal.window.endsAt).toBeNull();
    expect(signal.id.startsWith("sig_")).toBe(true);
  });

  it("makes the sarcastic fourth post add nothing", () => {
    const withJoke = verify([
      ...records,
      social("d", "tw:d", "TERBAIK LA RAPID KL, memang world class service. /s", "2024-03-05T08:20:00+08:00"),
    ]);
    expect(withJoke.signals[0].corroboratingSources.socialDistinctAuthors).toBe(3);
    expect(withJoke.signals[0].confidence.value).toBe(verify(records).signals[0].confidence.value);
  });
});

describe("reasoning agrees with the signal's own provenance", () => {
  const socialRecords = [
    social("a", "tw:a", "LRT Kelana Jaya tergendala. Tren berhenti antara KLCC dan Ampang Park.", "2024-03-05T08:05:00+08:00"),
    social("b", "tw:b", "Sistem isyarat rosak di Ampang Park, tren tak bergerak.", "2024-03-05T08:08:00+08:00"),
    social("c", "tw:c", "Signal fault kat LRT Kelana Jaya line, train stuck between KLCC and Ampang Park.", "2024-03-05T08:12:00+08:00"),
  ];
  const official: RawSourceRecord = {
    id: "off",
    sourceClass: "OFFICIAL_STATEMENT",
    title: "KENYATAAN MEDIA — GANGGUAN PERKHIDMATAN LRT LALUAN KELANA JAYA",
    text: "Rapid Rail memaklumkan gangguan perkhidmatan di LRT Laluan Kelana Jaya akibat masalah sistem isyarat di antara stesen KLCC dan Ampang Park. Bas perantara percuma disediakan.",
    publishedAt: "2024-03-05T08:52:00+08:00",
    retrievedAt: "2024-03-05T08:53:00+08:00",
    language: "ms",
  };

  it("says 'no official statement yet' only when there is genuinely none", () => {
    const signal = verify(socialRecords).signals[0];
    expect(signal.corroboratingSources.official).toBe(0);
    expect(signal.operatorNotifiedAt).toBeNull();
    expect(signal.reasoning).toMatch(/no official statement yet/);
    expect(signal.reasoning).not.toMatch(/corroborate/);
  });

  it("says the operator confirms when there is one", () => {
    const signal = verify([...socialRecords, official]).signals[0];
    expect(signal.corroboratingSources.official).toBe(1);
    expect(signal.operatorNotifiedAt).toBe("2024-03-05T08:52:00+08:00");
    expect(signal.reasoning).toMatch(/corroborate/);
    expect(signal.reasoning).not.toMatch(/no official statement yet/);
    expect(signal.status).toBe("CONFIRMED");
  });

  it("never lets the reasoning contradict the corroboration counts", () => {
    const result = verify([...socialRecords, official]);
    for (const signal of result.signals) {
      const saysNone = /no official statement yet/.test(signal.reasoning);
      expect(saysNone).toBe(signal.corroboratingSources.official === 0);
    }
  });
});

describe("source precedence", () => {
  it("raises confidence sharply when the operator confirms", () => {
    const socialOnly = verify([
      social("a", "tw:a", "LRT Kelana Jaya tergendala di antara KLCC dan Ampang Park.", "2024-03-05T08:05:00+08:00"),
      social("b", "tw:b", "Sistem isyarat rosak di Ampang Park.", "2024-03-05T08:08:00+08:00"),
      social("c", "tw:c", "Signal fault, train stuck between KLCC and Ampang Park.", "2024-03-05T08:12:00+08:00"),
    ]).signals[0];
    const confirmed = verify([
      social("a", "tw:a", "LRT Kelana Jaya tergendala di antara KLCC dan Ampang Park.", "2024-03-05T08:05:00+08:00"),
      social("b", "tw:b", "Sistem isyarat rosak di Ampang Park.", "2024-03-05T08:08:00+08:00"),
      social("c", "tw:c", "Signal fault, train stuck between KLCC and Ampang Park.", "2024-03-05T08:12:00+08:00"),
      {
        id: "off",
        sourceClass: "OFFICIAL_STATEMENT",
        text: "Gangguan perkhidmatan di LRT Laluan Kelana Jaya akibat masalah sistem isyarat di antara stesen KLCC dan Ampang Park.",
        publishedAt: "2024-03-05T08:52:00+08:00",
        retrievedAt: "2024-03-05T08:53:00+08:00",
      },
    ]).signals[0];
    expect(confirmed.confidence.value).toBeGreaterThan(socialOnly.confidence.value + 0.4);
    expect(confirmed.confidence.band).toBe("VERY_HIGH");
  });

  it("lets an official 'service normal' statement beat three complaints", () => {
    const result = verify([
      social("a", "tw:a", "LRT Kelana Jaya lambat lagi pagi ini.", "2024-03-05T09:20:00+08:00"),
      social("b", "tw:b", "Kelewatan LRT Kelana Jaya teruk sangat hari ini.", "2024-03-05T09:22:00+08:00"),
      social("c", "tw:c", "LRT Kelana Jaya delay 25 minit. Kenapa takde pengumuman?", "2024-03-05T09:25:00+08:00"),
      {
        id: "off",
        sourceClass: "OFFICIAL_STATEMENT",
        text: "Status terkini: perkhidmatan LRT Laluan Kelana Jaya beroperasi seperti biasa. Tiada gangguan dilaporkan.",
        publishedAt: "2024-03-05T09:30:00+08:00",
        retrievedAt: "2024-03-05T09:31:00+08:00",
      },
    ], "2024-03-05T09:40:00+08:00");
    expect(result.signals).toEqual([]);
    expect(result.rejected[0].reason).toMatch(/official source reports normal service/);
  });

  it("computes and clamps the lead time", () => {
    const confirmed = verify([
      social("a", "tw:a", "LRT Kelana Jaya tergendala di antara KLCC dan Ampang Park.", "2024-03-05T08:05:00+08:00"),
      {
        id: "off",
        sourceClass: "OFFICIAL_STATEMENT",
        text: "Gangguan perkhidmatan di LRT Laluan Kelana Jaya di antara stesen KLCC dan Ampang Park.",
        publishedAt: "2024-03-05T08:52:00+08:00",
        retrievedAt: "2024-03-05T08:53:00+08:00",
      },
    ]).signals[0];
    expect(confirmed.leadTimeMinutes).toBe(47);

    const late = verify([
      {
        id: "off",
        sourceClass: "OFFICIAL_STATEMENT",
        text: "Gangguan perkhidmatan di LRT Laluan Kelana Jaya di antara stesen KLCC dan Ampang Park.",
        publishedAt: "2024-03-05T08:52:00+08:00",
        retrievedAt: "2024-03-05T08:53:00+08:00",
      },
    ]).signals[0];
    // We learned about it after the operator announced it: zero lead time, not a
    // negative number and not a fabricated positive one.
    expect(late.leadTimeMinutes).toBe(0);
  });
});

describe("ambiguous locations refuse to pick", () => {
  const records = [
    social("a", "tw:a", "Stesen Klang penuh sesak pagi ini. Tren lambat 15 minit.", "2024-03-05T08:40:00+08:00"),
    social("b", "tw:b", "Klang: kelewatan 20 minit, platform sesak teruk.", "2024-03-05T08:44:00+08:00"),
    social("c", "tw:c", "Stesen Klang sesak, tren lambat lagi hari ini.", "2024-03-05T08:47:00+08:00"),
  ];

  it("yields UNRESOLVED with every candidate segment listed", () => {
    const result = verify(records);
    expect(result.signals.length).toBe(1);
    const signal = result.signals[0];
    expect(signal.resolution).toBe("UNRESOLVED");
    expect(signal.segmentIds).toEqual([]);
    expect(signal.stationIds).toEqual([]);
    expect(signal.unresolvedCandidates).toBeDefined();
    expect(signal.unresolvedCandidates!.length).toBeGreaterThanOrEqual(6);
    expect(signal.lineIds).toEqual(["SA"]);
    expect(signal.wouldAHumanCheckThis).toBe(true);
    expect(signal.reasoning).toMatch(/unresolved/i);
  });

  it("caps an unresolved score below the HIGH band", () => {
    const signal = verify(records).signals[0];
    expect(signal.confidence.value).toBeLessThanOrEqual(0.45);
    expect(signal.confidence.band).not.toBe("HIGH");
    expect(signal.confidence.band).not.toBe("VERY_HIGH");
  });

  it("lists every candidate segment for a line-wide claim and picks none", () => {
    const result = verify([
      social("a", "tw:a", "LALUAN KELANA JAYA terjejas teruk pagi ini. Tren lambat 30 minit.", "2024-03-05T07:55:00+08:00"),
      social("b", "tw:b", "Laluan Kelana Jaya lambat lagi. Dah 3 hari berturut-turut.", "2024-03-05T07:58:00+08:00"),
      social("c", "tw:c", "LALUAN KELANA JAYA: kelewatan 25 minit, tren tidak berhenti di beberapa stesen.", "2024-03-05T08:01:00+08:00"),
    ], "2024-03-05T08:30:00+08:00");
    const signal = result.signals[0];
    expect(signal.resolution).toBe("UNRESOLVED");
    expect(signal.segmentIds).toEqual([]);
    expect(signal.unresolvedCandidates!.length).toBe(72);
    expect(signal.lineIds).toEqual(["KJ"]);
  });
});

describe("time checks", () => {
  it("rejects a cluster whose every candidate is stale", () => {
    const result = verify([
      social("a", "tw:a", "Throwback 2022: LRT Kelana Jaya tutup 2 minggu, bas perantara percuma. Ingat tak? #tbt", "2024-03-05T08:30:00+08:00"),
      social("b", "tw:b", "Minggu lepas LRT Kelana Jaya ada gangguan isyarat di KLCC.", "2024-03-05T08:33:00+08:00"),
    ]);
    expect(result.signals).toEqual([]);
    expect(result.rejected[0].reason).toMatch(/stale/);
  });

  it("rejects evidence older than the incident window", () => {
    const result = verify([
      social("a", "tw:a", "LRT Kelana Jaya lambat di KLCC.", "2024-03-05T05:00:00+08:00"),
      social("b", "tw:b", "LRT Kelana Jaya lambat di KLCC juga.", "2024-03-05T05:10:00+08:00"),
      social("c", "tw:c", "LRT Kelana Jaya lambat di KLCC betul ke?", "2024-03-05T05:20:00+08:00"),
    ], "2024-03-05T09:00:00+08:00");
    expect(result.signals).toEqual([]);
    expect(result.rejected[0].reason).toMatch(/outside the 90 min window/);
  });
});

describe("signal store, lifecycle and source precedence", () => {
  function makeSignal(records: RawSourceRecord[], now = NOW): DisruptionSignal {
    return verify(records, now).signals[0];
  }

  const socials = [
    social("a", "tw:a", "LRT Kelana Jaya tergendala di antara KLCC dan Ampang Park.", "2024-03-05T08:05:00+08:00"),
    social("b", "tw:b", "Sistem isyarat rosak di Ampang Park.", "2024-03-05T08:08:00+08:00"),
    social("c", "tw:c", "Signal fault, train stuck between KLCC and Ampang Park.", "2024-03-05T08:12:00+08:00"),
  ];
  const official: RawSourceRecord = {
    id: "off",
    sourceClass: "OFFICIAL_STATEMENT",
    text: "Gangguan perkhidmatan di LRT Laluan Kelana Jaya di antara stesen KLCC dan Ampang Park.",
    publishedAt: "2024-03-05T08:52:00+08:00",
    retrievedAt: "2024-03-05T08:53:00+08:00",
  };

  it("adds a new signal, then updates rather than duplicating it", () => {
    const store = new SignalStore({ now: () => new Date("2024-03-05T09:00:00+08:00") });
    const first = store.upsert([makeSignal(socials)]);
    expect(first.added.length).toBe(1);
    expect(store.all().length).toBe(1);

    const second = store.upsert([makeSignal([...socials, official], "2024-03-05T09:10:00+08:00")]);
    expect(second.added.length).toBe(0);
    expect(second.updated.length).toBe(1);
    expect(store.all().length).toBe(1);
  });

  it("never un-confirms a signal when more social chatter arrives", () => {
    const store = new SignalStore({ now: () => new Date("2024-03-05T09:00:00+08:00") });
    store.upsert([makeSignal([...socials, official], "2024-03-05T09:10:00+08:00")]);
    expect(store.all()[0].status).toBe("CONFIRMED");

    const later = store.upsert([
      makeSignal(
        [...socials, social("d", "tw:d", "LRT Kelana Jaya masih teruk di Ampang Park.", "2024-03-05T09:20:00+08:00")],
        "2024-03-05T09:30:00+08:00",
      ),
    ]);
    expect(later.updated.length + later.unchanged.length).toBeGreaterThan(0);
    expect(store.all()[0].status).toBe("CONFIRMED");
    expect(store.all()[0].operatorNotifiedAt).toBe("2024-03-05T08:52:00+08:00");
  });

  it("carries the evidence summary on the VERIFY hop so a merge can re-derive counts", () => {
    const signal = makeSignal(socials);
    const summary = readEvidenceSummary(signal);
    expect(summary).not.toBeNull();
    expect(summary!.socialAuthors).toEqual(["tw:a", "tw:b", "tw:c"]);
    expect(summary!.officialStatementCount).toBe(0);
    expect(summary!.calibrationInput).not.toBeNull();
  });

  it("counts distinct authors, not source rows, after a merge", () => {
    const store = new SignalStore({ now: () => new Date("2024-03-05T09:00:00+08:00") });
    store.upsert([makeSignal(socials)]);
    store.upsert([
      makeSignal(
        [
          social("a2", "tw:a", "LRT Kelana Jaya masih tergendala antara KLCC dan Ampang Park.", "2024-03-05T08:30:00+08:00"),
          social("d", "tw:d", "Tren tak bergerak di Ampang Park, sistem isyarat.", "2024-03-05T08:31:00+08:00"),
        ],
        "2024-03-05T09:00:00+08:00",
      ),
    ]);
    const merged = store.all()[0];
    expect(merged.corroboratingSources.socialDistinctAuthors).toBe(4);
    expect(merged.sources.length).toBe(5);
  });

  it("clears and rejects through the lifecycle API", () => {
    const store = new SignalStore({ now: () => new Date("2024-03-05T09:00:00+08:00") });
    const signal = makeSignal(socials);
    store.upsert([signal]);
    expect(store.clear(signal.id)).toBe(true);
    expect(store.get(signal.id)?.status).toBe("CLEARED");
    expect(store.active(new Date("2024-03-05T09:05:00+08:00"))).toEqual([]);
  });

  it("keeps a rejected source from re-entering", () => {
    const store = new SignalStore({ now: () => new Date("2024-03-05T09:00:00+08:00") });
    const signal = makeSignal(socials);
    store.rejectSource(signal.sources[0].contentHash);
    const result = store.upsert([signal]);
    expect(result.added).toEqual([]);
    expect(result.unchanged.length).toBe(1);
    expect(store.all()).toEqual([]);
  });

  it("round-trips through a snapshot", () => {
    const store = new SignalStore({ now: () => new Date("2024-03-05T09:00:00+08:00") });
    store.upsert([makeSignal(socials)]);
    const snapshot = store.snapshot();
    const restored = new SignalStore({ now: () => new Date("2024-03-05T09:00:00+08:00") });
    restored.restore(snapshot);
    expect(restored.all()).toEqual(store.all());
  });

  it("supersedes an old incident on the same identity instead of merging it", () => {
    const store = new SignalStore({ now: () => new Date("2024-03-05T09:00:00+08:00"), mergeWindowMinutes: 30 });
    store.upsert([makeSignal(socials, "2024-03-05T09:00:00+08:00")]);
    const later = store.upsert([
      makeSignal(
        [
          social("x", "tw:x", "LRT Kelana Jaya tergendala antara KLCC dan Ampang Park lagi.", "2024-03-05T14:00:00+08:00"),
          social("y", "tw:y", "Sistem isyarat rosak di Ampang Park.", "2024-03-05T14:02:00+08:00"),
          social("z", "tw:z", "Signal fault between KLCC and Ampang Park.", "2024-03-05T14:04:00+08:00"),
        ],
        "2024-03-05T14:10:00+08:00",
      ),
    ]);
    expect(later.superseded.length).toBe(1);
    expect(later.added.length).toBe(1);
    expect(store.all().length).toBe(1);
  });
});

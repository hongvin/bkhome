import { describe, expect, it } from "vitest";

import { ingestBatch } from "@/lib/agents/ingest/normalize";
import {
  MIN_INCIDENTAL_REPOST_LENGTH,
  clusterCandidates,
  collapseReposts,
  distinctSocialAuthors,
  signalIdFor,
} from "@/lib/signals/dedupe";
import type { IngestCandidate, RawSourceRecord } from "@/lib/signals/types";

const NOW = "2024-03-05T09:00:00+08:00";

function post(over: Partial<RawSourceRecord> & { id: string; text: string }): RawSourceRecord {
  return {
    sourceClass: "SOCIAL",
    publishedAt: "2024-03-05T08:10:00+08:00",
    retrievedAt: "2024-03-05T08:10:20+08:00",
    authorId: `tw:${over.id}`,
    ...over,
  };
}

function candidates(records: RawSourceRecord[]): IngestCandidate[] {
  return ingestBatch(records, { now: NOW });
}

describe("reposts do not inflate confidence", () => {
  const original = post({
    id: "orig",
    authorId: "tw:ina",
    authorHandle: "@ina",
    text: "MRT Kajang line tergendala di stesen Maluri. Tren tak bergerak sejak 20 minit. GANGGUAN PERKHIDMATAN.",
  });
  const reposts = [1, 2, 3, 4, 5].map((n) =>
    post({
      id: `repost-${n}`,
      authorId: `tw:bot${n}`,
      authorHandle: `@bot${n}`,
      originalAuthorId: "tw:ina",
      originalAuthorHandle: "@ina",
      repostOfId: "orig",
      text: "RT @ina: MRT Kajang line tergendala di stesen Maluri. Tren tak bergerak sejak 20 minit. GANGGUAN PERKHIDMATAN.",
      publishedAt: `2024-03-05T08:1${n}:00+08:00`,
    }),
  );

  it("collapses six posts from six accounts into ONE witness", () => {
    const all = candidates([original, ...reposts]);
    expect(all.length).toBe(6);

    const { unique, collapsed } = collapseReposts(all);
    expect(unique.length).toBe(1);
    expect(collapsed.size).toBe(5);
    expect(unique[0].id).toBe("orig");

    const summary = distinctSocialAuthors(unique);
    expect(summary.authors).toEqual(["tw:ina"]);
  });

  it("counts the raw volume when explicitly asked to, so the drop is visible", () => {
    const all = candidates([original, ...reposts]);
    const raw = distinctSocialAuthors(collapseReposts(all).unique, { includeJunk: true });
    // Reposts collapse to the original author even in raw mode: volume is never
    // inflated by copying.
    expect(raw.authors).toEqual(["tw:ina"]);
  });

  it("does not collapse two short identical posts by different authors", () => {
    const a = post({ id: "a", authorId: "tw:a", text: "LRT rosak" });
    const b = post({ id: "b", authorId: "tw:b", text: "LRT rosak" });
    const { unique } = collapseReposts(candidates([a, b]));
    expect(unique.length).toBe(2);
    expect(distinctSocialAuthors(unique).authors).toEqual(["tw:a", "tw:b"]);
  });

  it("does collapse identical long text from different authors", () => {
    const long =
      "LRT Kelana Jaya tergendala teruk pagi ini di antara KLCC dan Ampang Park, tren tidak bergerak langsung.";
    expect(long.length).toBeGreaterThanOrEqual(MIN_INCIDENTAL_REPOST_LENGTH);
    const a = post({ id: "a", authorId: "tw:a", text: long });
    const b = post({ id: "b", authorId: "tw:b", text: long });
    const { unique } = collapseReposts(candidates([a, b]));
    expect(unique.length).toBe(1);
  });

  it("drops the same author posting twice", () => {
    const a = post({ id: "a", authorId: "tw:a", text: "LRT rosak" });
    const b = post({ id: "b", authorId: "tw:a", text: "LRT rosak" });
    const { unique } = collapseReposts(candidates([a, b]));
    expect(unique.length).toBe(1);
  });
});

describe("distinct authors do inflate confidence", () => {
  it("counts three independent authors as three", () => {
    const records = [
      post({ id: "a", authorId: "tw:a", text: "LRT Kelana Jaya lambat 20 minit di KLCC." }),
      post({ id: "b", authorId: "tw:b", text: "Tren LRT Kelana Jaya tak bergerak di Ampang Park." }),
      post({ id: "c", authorId: "tw:c", text: "Kelewatan LRT Kelana Jaya teruk pagi ini." }),
    ];
    const { unique } = collapseReposts(candidates(records));
    const summary = distinctSocialAuthors(unique);
    expect(summary.authors).toEqual(["tw:a", "tw:b", "tw:c"]);
    expect(summary.quality).toBeCloseTo(1, 6);
  });

  it("excludes junk posts from the author count but reports how many were dropped", () => {
    const records = [
      post({ id: "a", authorId: "tw:a", text: "LRT Kelana Jaya lambat 20 minit di KLCC." }),
      post({ id: "b", authorId: "tw:b", text: "TERBAIK LA RAPID, LRT delay 40 minit, memang world class. /s" }),
      post({ id: "c", authorId: "tw:c", text: "Tren LRT Kelana Jaya tak bergerak di Ampang Park." }),
    ];
    const { unique } = collapseReposts(candidates(records));
    const summary = distinctSocialAuthors(unique);
    expect(summary.authors).toEqual(["tw:a", "tw:c"]);
    expect(summary.junkCount).toBe(1);
  });

  it("counts authorless posts as distinct sources", () => {
    const records = [
      { id: "a", sourceClass: "SOCIAL", text: "LRT rosak", publishedAt: "2024-03-05T08:10:00+08:00", retrievedAt: "2024-03-05T08:10:20+08:00" },
      { id: "b", sourceClass: "SOCIAL", text: "Tren tak bergerak", publishedAt: "2024-03-05T08:11:00+08:00", retrievedAt: "2024-03-05T08:11:20+08:00" },
    ] as RawSourceRecord[];
    const { unique } = collapseReposts(candidates(records));
    const summary = distinctSocialAuthors(unique);
    expect(summary.authors.length).toBe(2);
    expect(summary.anonymousCount).toBe(2);
  });
});

describe("incident clustering", () => {
  const footprint = (c: IngestCandidate) => ({
    segmentIds: c.normalizedText.includes("KLCC") ? ["KJ:KJ10->KJ9"] : ["KJ:KJ9->KJ8"],
    lineIds: ["KJ"],
    stationIds: [],
    placeKeys: [],
    locationKey: "NONE",
    issueType: c.parse.issueType,
  });

  it("merges candidates that share a segment inside the window", () => {
    const records = [
      post({ id: "a", text: "LRT KLCC tren tak bergerak" }),
      post({ id: "b", text: "LRT KLCC sesak teruk", publishedAt: "2024-03-05T08:20:00+08:00" }),
    ];
    const clusters = clusterCandidates(candidates(records), { windowMinutes: 90, footprintOf: footprint });
    expect(clusters.length).toBe(1);
    expect(clusters[0].candidates.length).toBe(2);
  });

  it("splits candidates that are too far apart in time", () => {
    const records = [
      post({ id: "a", text: "LRT KLCC tren tak bergerak", publishedAt: "2024-03-05T05:00:00+08:00" }),
      post({ id: "b", text: "LRT KLCC sesak teruk", publishedAt: "2024-03-05T08:20:00+08:00" }),
    ];
    const clusters = clusterCandidates(candidates(records), { windowMinutes: 90, footprintOf: footprint });
    expect(clusters.length).toBe(2);
  });

  it("keeps unrelated segments apart", () => {
    const records = [
      post({ id: "a", text: "LRT KLCC tren tak bergerak" }),
      post({ id: "b", text: "Tren tak bergerak di stesen lain", publishedAt: "2024-03-05T08:20:00+08:00" }),
    ];
    const clusters = clusterCandidates(candidates(records), { windowMinutes: 90, footprintOf: footprint });
    expect(clusters.length).toBe(2);
  });

  it("is order-independent", () => {
    const records = [
      post({ id: "a", text: "LRT KLCC tren tak bergerak" }),
      post({ id: "b", text: "LRT KLCC sesak teruk", publishedAt: "2024-03-05T08:20:00+08:00" }),
      post({ id: "c", text: "LRT KLCC lambat", publishedAt: "2024-03-05T08:30:00+08:00" }),
    ];
    const forward = clusterCandidates(candidates(records), { windowMinutes: 90, footprintOf: footprint });
    const backward = clusterCandidates(candidates([...records].reverse()), {
      windowMinutes: 90,
      footprintOf: footprint,
    });
    expect(forward.map((c) => c.candidates.map((x) => x.id))).toEqual(
      backward.map((c) => c.candidates.map((x) => x.id)),
    );
  });
});

describe("signal ids", () => {
  it("are deterministic and independent of the clock", () => {
    const a = signalIdFor(["SIGNAL_FAULT", "KJ:KJ10->KJ9", NOW]);
    const b = signalIdFor(["SIGNAL_FAULT", "KJ:KJ10->KJ9", NOW]);
    const c = signalIdFor(["SIGNAL_FAULT", "KJ:KJ9->KJ10", NOW]);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a.startsWith("sig_")).toBe(true);
  });
});

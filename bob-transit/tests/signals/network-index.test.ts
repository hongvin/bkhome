import { describe, expect, it } from "vitest";

import { loadNetworkIndexFromGtfs, parseSnapshot } from "@/lib/signals/network/source";
import { CANONICAL_LINE_IDS, isCanonicalLineId, toCanonicalLineId } from "@/lib/signals/network/parse";
import { networkIndex } from "@/lib/signals";
import snapshotJson from "@/data/corpus/network/network-index.snapshot.json";

describe("canonical line ids", () => {
  it("maps every feed dialect onto the routes.txt set", () => {
    expect(toCanonicalLineId("AGL")).toBe("AG");
    expect(toCanonicalLineId("KJL")).toBe("KJ");
    expect(toCanonicalLineId("SPL")).toBe("PH");
    expect(toCanonicalLineId("MRL")).toBe("MR");
    expect(toCanonicalLineId("SAL")).toBe("SA");
    // stops.txt writes the Kajang line as "MRT"; the canonical id is KGL.
    expect(toCanonicalLineId("MRT")).toBe("KGL");
    expect(toCanonicalLineId("KGL")).toBe("KGL");
    expect(toCanonicalLineId("PYL")).toBe("PYL");
    expect(toCanonicalLineId("BRT")).toBe("BRT");
    expect(toCanonicalLineId("NOPE")).toBeNull();
  });

  it("rejects anything outside the canonical set", () => {
    for (const id of CANONICAL_LINE_IDS) expect(isCanonicalLineId(id)).toBe(true);
    expect(isCanonicalLineId("MRT")).toBe(false);
    expect(isCanonicalLineId("AGL")).toBe(false);
  });
});

describe("committed network snapshot", () => {
  it("indexes the whole Klang Valley rail network", () => {
    const index = networkIndex();
    expect(index.lines.length).toBe(8);
    expect(index.stations.length).toBe(187);
    expect(index.segments.length).toBe(358);
    expect(index.warnings).toEqual([]);
  });

  it("emits canonical line ids only", () => {
    const index = networkIndex();
    for (const line of index.lines) expect(isCanonicalLineId(line.id)).toBe(true);
    for (const station of index.stations) {
      for (const lineId of station.lineIds) expect(isCanonicalLineId(lineId)).toBe(true);
    }
    for (const segment of index.segments) expect(isCanonicalLineId(segment.lineId)).toBe(true);
  });

  it("gives every segment a both-directions counterpart", () => {
    const index = networkIndex();
    for (const segment of index.segments) {
      const reverse = index.segmentById.get(
        `${segment.lineId}:${segment.toStationId}->${segment.fromStationId}`,
      );
      expect(reverse, `missing reverse of ${segment.id}`).toBeDefined();
    }
  });

  it("collapses interchanges to one physical place but not separate stations", () => {
    const index = networkIndex();
    // Masjid Jamek: one place, three platforms.
    for (const id of ["KJ13", "SP7", "AG7"]) {
      expect(index.stationById.get(id)?.lineIds.sort()).toEqual(["AG", "KJ", "PH"]);
      expect(index.stationById.get(id)?.isInterchange).toBe(true);
    }
    // Dang Wangi / Bukit Nanas: different names, curated link.
    expect(index.stationById.get("KJ12")?.lineIds.sort()).toEqual(["KJ", "MR"]);
    expect(index.stationById.get("MR8")?.lineIds.sort()).toEqual(["KJ", "MR"]);
    // Ampang Park: same name on two lines.
    expect(index.stationById.get("KJ9")?.lineIds.sort()).toEqual(["KJ", "PYL"]);
    // Genuinely separate stations must NOT be merged.
    expect(index.stationById.get("KG15")?.lineIds).toEqual(["KGL"]);
    expect(index.stationById.get("KJ28")?.lineIds).toEqual(["KJ"]);
  });

  it("keeps segment sequences comparable across both travel directions", () => {
    const index = networkIndex();
    const forward = index.segmentById.get("KJ:KJ10->KJ9");
    const backward = index.segmentById.get("KJ:KJ9->KJ10");
    expect(forward).toBeDefined();
    expect(backward).toBeDefined();
    expect(Math.min(forward!.fromSequence, forward!.toSequence)).toBe(
      Math.min(backward!.fromSequence, backward!.toSequence),
    );
    expect(Math.max(forward!.fromSequence, forward!.toSequence)).toBe(
      Math.max(backward!.fromSequence, backward!.toSequence),
    );
  });

  it("is still identical to the committed GTFS feed", async () => {
    const fromFeed = await loadNetworkIndexFromGtfs();
    const fromSnapshot = networkIndex();
    expect(fromSnapshot.stations).toEqual(fromFeed.stations);
    expect(fromSnapshot.segments).toEqual(fromFeed.segments);
    expect(fromSnapshot.lines).toEqual(fromFeed.lines);
  });
});

describe("snapshot boundary parsing", () => {
  it("accepts the committed fixture", () => {
    const parsed = parseSnapshot(snapshotJson);
    expect(parsed.stations.length).toBe(187);
    expect(parsed.segments.length).toBe(358);
  });

  it("rejects malformed records instead of trusting them", () => {
    const parsed = parseSnapshot({
      stations: [{ id: "X1", name: "X", sequenceByLine: { KJ: 1, AG: "nope" } }],
      segments: [{ id: "", lineId: "KJ" }, { id: "S1", lineId: "KJ" }],
      lines: [{}],
    });
    expect(parsed.stations.length).toBe(1);
    expect(parsed.stations[0].sequenceByLine).toEqual({ KJ: 1 });
    expect(parsed.segments.length).toBe(1);
    expect(parsed.lines.length).toBe(0);
  });
});

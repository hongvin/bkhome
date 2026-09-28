/**
 * Interchange transfer-time model tests.
 *
 * The coordinate test re-reads the committed `stops.txt` and asserts every
 * platform in `INTERCHANGE_CLUSTERS` matches it, and that the cluster set is
 * exactly the set of real multi-platform station names in the feed.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  INTERCHANGE_CLUSTERS,
  SAME_PLATFORM_WALK_SECONDS,
  STOP_ROUTE_ID_TO_LINE_ID,
  estimateTransferSeconds,
  estimateWalkSeconds,
  findInterchangeCluster,
  haversineMeters,
  isInterchangeStation,
} from "@/lib/risk/interchange";

const GTFS_DIR = resolve(process.cwd(), "data/gtfs-static/rapid-rail-kl");

function readCsv(name: string): string[][] {
  return readFileSync(resolve(GTFS_DIR, name), "utf8")
    .replace(/^\uFEFF/, "")
    .trim()
    .split("\n")
    .map((line) => line.split(","));
}

describe("interchange clusters are grounded in the real feed", () => {
  const stops = readCsv("stops.txt");
  const header = stops[0];
  const index = Object.fromEntries(header.map((c, i) => [c, i]));
  const rows = stops.slice(1);

  it("has the exact set of multi-platform station names found in stops.txt", () => {
    const normalise = (name: string) =>
      name.trim().toUpperCase().replace(/\s+/g, " ").replace(/\s*-\s*REDONE$/, "");
    const byName = new Map<string, string[]>();
    for (const row of rows) {
      const key = normalise(row[index.stop_name]);
      const list = byName.get(key);
      if (list) list.push(row[index.stop_id]);
      else byName.set(key, [row[index.stop_id]]);
    }
    const expected = [...byName.entries()]
      .filter(([, ids]) => ids.length > 1)
      .map(([name]) => name)
      .sort();
    expect(INTERCHANGE_CLUSTERS.map((c) => c.name).sort()).toEqual(expected);
  });

  it("matches stops.txt coordinates and canonical line ids for every platform", () => {
    const byId = new Map(
      rows.map((row) => [
        row[index.stop_id],
        { lat: Number(row[index.stop_lat]), lon: Number(row[index.stop_lon]), route: row[index.route_id] },
      ]),
    );

    for (const cluster of INTERCHANGE_CLUSTERS) {
      expect(cluster.platforms.length).toBeGreaterThan(1);
      const seen = new Set<string>();
      for (const platform of cluster.platforms) {
        const row = byId.get(platform.stationId);
        expect(row, `${cluster.name}: ${platform.stationId} missing from stops.txt`).toBeDefined();
        expect(platform.lat).toBeCloseTo(row?.lat ?? Number.NaN, 6);
        expect(platform.lon).toBeCloseTo(row?.lon ?? Number.NaN, 6);
        // stops.txt calls the MRT Kajang line "MRT"; routes.txt calls it "KGL".
        expect(platform.lineId).toBe(STOP_ROUTE_ID_TO_LINE_ID[row?.route ?? ""] ?? row?.route);
        expect(seen.has(platform.stationId)).toBe(false);
        seen.add(platform.stationId);
      }
    }
  });

  it("handles the canonical Masjid Jamek three-platform case", () => {
    const ag = findInterchangeCluster("AG7");
    const sp = findInterchangeCluster("SP7");
    const kj = findInterchangeCluster("KJ13");
    expect(ag).toBeDefined();
    expect(ag).toBe(sp);
    expect(ag).toBe(kj);
    expect(ag?.name).toBe("MASJID JAMEK");
    expect(isInterchangeStation("AG7")).toBe(true);
    expect(isInterchangeStation("KJ10")).toBe(false);
  });
});

describe("estimateWalkSeconds", () => {
  it("treats the AG/PH city-core platforms as same-platform", () => {
    const walk = estimateWalkSeconds("AG7", "SP7");
    expect(walk.basis).toBe("same-platform");
    expect(walk.seconds).toBe(SAME_PLATFORM_WALK_SECONDS);
  });

  it("uses the curated minimum where the straight line understates the walk", () => {
    const walk = estimateWalkSeconds("AG7", "KJ13");
    expect(walk.basis).toBe("curated-minimum");
    expect(walk.seconds).toBe(180);
    // 69 m apart, but the real walk goes through the concourse and across.
    expect(walk.straightLineMeters).toBeGreaterThan(50);
    expect(walk.seconds).toBeGreaterThan(walk.straightLineMeters / 1.1);
  });

  it("uses the distance model where that is the longer of the two", () => {
    // KL Sentral KJ15 <-> MR1 is 246 m of straight line, longer than the 240 s
    // curated minimum once circulation is added.
    const walk = estimateWalkSeconds("KJ15", "MR1");
    expect(walk.basis).toBe("distance-model");
    expect(walk.straightLineMeters).toBeGreaterThan(200);
    expect(walk.seconds).toBeGreaterThan(240);
  });

  it("applies the Titiwangsa per-pair overrides", () => {
    expect(estimateWalkSeconds("AG3", "MR11").seconds).toBe(300);
    expect(estimateWalkSeconds("AG3", "PY17").seconds).toBe(240);
    expect(estimateWalkSeconds("MR11", "PY17").seconds).toBe(330);
  });

  it("refuses to price a transfer that does not exist", () => {
    expect(() => estimateWalkSeconds("KJ10", "AG7")).toThrow(/not platforms of the same interchange/);
  });
});

describe("estimateTransferSeconds", () => {
  it("adds the expected platform wait to the in-station walk", () => {
    const transfer = estimateTransferSeconds({
      fromStationId: "AG7",
      toStationId: "KJ13",
      atTime: 8 * 3600,
      serviceWeekday: 1,
    });

    expect(transfer).not.toBeNull();
    expect(transfer?.clusterName).toBe("MASJID JAMEK");
    expect(transfer?.walkSeconds).toBe(180);
    // KJ peak headway is 240 s, so the expected wait is 120 s.
    expect(transfer?.headwaySeconds).toBe(240);
    expect(transfer?.platformWaitSeconds).toBe(120);
    expect(transfer?.totalSeconds).toBe(300);
    expect(transfer?.headwayDegraded).toBe(false);
    expect(transfer?.note).toContain("MASJID JAMEK");
  });

  it("prices the long, uncertain wait when the connecting line is disrupted", () => {
    const healthy = estimateTransferSeconds({
      fromStationId: "AG7",
      toStationId: "KJ13",
      atTime: 8 * 3600,
      serviceWeekday: 1,
    });
    const disrupted = estimateTransferSeconds({
      fromStationId: "AG7",
      toStationId: "KJ13",
      atTime: 8 * 3600,
      serviceWeekday: 1,
      disruption: {
        severity: "SEVERE",
        issueType: "TRACK_FAULT",
        confidence: 1,
        isOngoing: true,
      },
    });

    expect(disrupted?.headwayDegraded).toBe(true);
    expect(disrupted?.headwaySeconds).toBeCloseTo(240 * 3.3625, 6);
    expect(disrupted?.totalSeconds).toBeGreaterThan(healthy?.totalSeconds ?? 0);
    expect(disrupted?.note).toContain("degraded by an active disruption");
  });

  it("honours an explicit connecting headway", () => {
    const transfer = estimateTransferSeconds({
      fromStationId: "AG7",
      toStationId: "KJ13",
      connectingHeadwaySeconds: 600,
    });
    expect(transfer?.platformWaitSeconds).toBe(300);
    expect(transfer?.totalSeconds).toBe(480);
  });

  it("returns null for a pair that is not an interchange", () => {
    expect(estimateTransferSeconds({ fromStationId: "KJ10", toStationId: "AG7" })).toBeNull();
    expect(estimateTransferSeconds({ fromStationId: "AG7", toStationId: "AG7" })).toBeNull();
    expect(estimateTransferSeconds({ fromStationId: "AG7", toStationId: "NOPE" })).toBeNull();
  });

  it("is deterministic", () => {
    const args = { fromStationId: "AG9", toStationId: "MR4", atTime: 8 * 3600, serviceWeekday: 1 };
    expect(estimateTransferSeconds(args)).toEqual(estimateTransferSeconds(args));
  });
});

describe("haversineMeters", () => {
  it("is zero for the same point and plausible for a known pair", () => {
    expect(haversineMeters({ lat: 3.14, lon: 101.69 }, { lat: 3.14, lon: 101.69 })).toBe(0);
    // Masjid Jamek KJ13 -> AG7 measured at 69 m in the fixture.
    const meters = haversineMeters({ lat: 3.149714, lon: 101.696815 }, { lat: 3.14927, lon: 101.696377 });
    expect(meters).toBeGreaterThan(50);
    expect(meters).toBeLessThan(90);
  });
});

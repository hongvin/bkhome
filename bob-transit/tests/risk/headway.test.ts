/**
 * Headway model tests.
 *
 * The headline test re-parses the REAL committed GTFS `frequencies.txt` and
 * asserts that `HEADWAY_PROFILES` matches it exactly. That is the evidence that
 * the A7 headway tool is grounded in the feed rather than in invented numbers.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { SEVERITIES } from "@/lib/contracts";
import {
  HEADWAY_DEGRADATION_MAX_MULTIPLIER,
  type HeadwayWindow,
  baseHeadwaySeconds,
  degradedHeadwaySeconds,
  expectedPlatformWaitSeconds,
  headwayDegradationMultiplier,
  headwayWindowsFor,
  serviceClassForWeekday,
  HEADWAY_PROFILES,
} from "@/lib/risk/headway";

const GTFS_DIR = resolve(process.cwd(), "data/gtfs-static/rapid-rail-kl");

function readCsv(name: string): string[][] {
  return readFileSync(resolve(GTFS_DIR, name), "utf8")
    .replace(/^\uFEFF/, "")
    .trim()
    .split("\n")
    .map((line) => line.split(","));
}

function toSeconds(value: string): number {
  const [h, m, s] = value.split(":").map(Number);
  return h * 3600 + m * 60 + (s ?? 0);
}

const SERVICE_CLASS: Record<string, string> = {
  MonFri: "WEEKDAY",
  Sat: "SATURDAY",
  Sun: "SUNDAY",
};

/**
 * Rebuild the expected table from the fixture the same way the model was built:
 * at every instant take the WORST (largest) headway across the directions active
 * then, then merge adjacent equal windows.
 */
function profilesFromFixture(): Map<string, HeadwayWindow[]> {
  const trips = readCsv("trips.txt");
  const tripHeader = trips[0];
  const tripIndex = Object.fromEntries(tripHeader.map((c, i) => [c, i]));
  const tripMeta = new Map(
    trips.slice(1).map((row) => [
      row[tripIndex.trip_id],
      { route: row[tripIndex.route_id], service: row[tripIndex.service_id] },
    ]),
  );

  const frequencies = readCsv("frequencies.txt");
  const records = frequencies.slice(1).map((row) => {
    const meta = tripMeta.get(row[0]);
    if (!meta) throw new Error(`unknown trip ${row[0]}`);
    return {
      route: meta.route,
      service: SERVICE_CLASS[meta.service],
      start: toSeconds(row[1]),
      end: toSeconds(row[2]),
      headway: Number(row[3]),
    };
  });

  const grouped = new Map<string, typeof records>();
  for (const record of records) {
    const key = `${record.route}|${record.service}`;
    const list = grouped.get(key);
    if (list) list.push(record);
    else grouped.set(key, [record]);
  }

  const out = new Map<string, HeadwayWindow[]>();
  for (const [key, list] of grouped) {
    const boundaries = [...new Set(list.flatMap((r) => [r.start, r.end]))].sort((a, b) => a - b);
    const windows: HeadwayWindow[] = [];
    for (let i = 0; i < boundaries.length - 1; i += 1) {
      const start = boundaries[i];
      const end = boundaries[i + 1];
      const active = list.filter((r) => r.start <= start && r.end >= end);
      if (active.length === 0) continue;
      const headwaySeconds = Math.max(...active.map((r) => r.headway));
      const last = windows[windows.length - 1];
      if (last && last.headwaySeconds === headwaySeconds && last.endSeconds === start) {
        last.endSeconds = end;
      } else {
        windows.push({ startSeconds: start, endSeconds: end, headwaySeconds });
      }
    }
    out.set(key, windows);
  }
  return out;
}

describe("HEADWAY_PROFILES matches the real GTFS frequencies.txt", () => {
  const expected = profilesFromFixture();

  it("has exactly the same (line, service) keys as the feed", () => {
    const actualKeys = HEADWAY_PROFILES.map((p) => `${p.lineId}|${p.service}`).sort();
    expect(actualKeys).toEqual([...expected.keys()].sort());
  });

  it("has byte-identical windows for every line and service class", () => {
    for (const [key, windows] of expected) {
      const [lineId, service] = key.split("|");
      const profile = HEADWAY_PROFILES.find((p) => p.lineId === lineId && p.service === service);
      expect(profile, `missing profile for ${key}`).toBeDefined();
      expect(profile?.windows, `windows for ${key}`).toEqual(windows);
    }
  });

  it("encodes the real published headways", () => {
    // Verified against the feed: KJ peak 240 s / off-peak 420 s, AG peak 180 s,
    // KGL peak 360 s, MR weekend 720 s.
    expect(baseHeadwaySeconds("KJ", 8 * 3600, 1)).toBe(240);
    expect(baseHeadwaySeconds("KJ", 12 * 3600, 1)).toBe(420);
    expect(baseHeadwaySeconds("AG", 8 * 3600, 1)).toBe(180);
    expect(baseHeadwaySeconds("KGL", 8 * 3600, 1)).toBe(360);
    expect(baseHeadwaySeconds("MR", 12 * 3600, 0)).toBe(720);
    expect(baseHeadwaySeconds("PH", 12 * 3600, 6)).toBe(300);
  });
});

describe("baseHeadwaySeconds", () => {
  it("returns null outside the service day rather than inventing a wait", () => {
    expect(baseHeadwaySeconds("KJ", 5 * 3600, 1)).toBeNull();
    expect(baseHeadwaySeconds("KJ", 23 * 3600 + 1800, 1)).toBeNull();
    expect(baseHeadwaySeconds("NOT_A_LINE", 8 * 3600, 1)).toBeNull();
  });

  it("maps weekdays onto the three service classes", () => {
    expect(serviceClassForWeekday(0)).toBe("SUNDAY");
    expect(serviceClassForWeekday(6)).toBe("SATURDAY");
    for (const day of [1, 2, 3, 4, 5]) expect(serviceClassForWeekday(day)).toBe("WEEKDAY");
    expect(serviceClassForWeekday(-1)).toBe("SATURDAY");
    expect(serviceClassForWeekday(7)).toBe("SUNDAY");
  });

  it("exposes the windows it used", () => {
    expect(headwayWindowsFor("KJ", 1).length).toBeGreaterThan(0);
    expect(headwayWindowsFor("KJ", 0)).toEqual(headwayWindowsFor("KJ", 6));
  });
});

describe("headway degradation", () => {
  const offPeak = { atTime: 12 * 3600, isOngoing: true };

  it("is monotonic non-decreasing in severity", () => {
    const multipliers = SEVERITIES.map((severity) =>
      headwayDegradationMultiplier({ severity, issueType: "TRACK_FAULT", confidence: 0.8, ...offPeak }),
    );
    for (let i = 1; i < multipliers.length; i += 1) {
      expect(multipliers[i]).toBeGreaterThanOrEqual(multipliers[i - 1]);
    }
    expect(multipliers[0]).toBe(1);
  });

  it("scales with severity x confidence x issueTypeWeight", () => {
    const severe = headwayDegradationMultiplier({
      severity: "SEVERE",
      issueType: "TRACK_FAULT",
      confidence: 1,
      ...offPeak,
    });
    expect(severe).toBeCloseTo(1 + 1.75 * 1.0 * 1.35, 10);

    const elevator = headwayDegradationMultiplier({
      severity: "SEVERE",
      issueType: "ELEVATOR_FAULT",
      confidence: 1,
      ...offPeak,
    });
    expect(elevator).toBeLessThan(severe);
  });

  it("caps the degradation so a line is never modelled as infinitely slow", () => {
    const multiplier = headwayDegradationMultiplier({
      severity: "SEVERE",
      issueType: "TRACK_FAULT",
      confidence: 1,
      atTime: 8 * 3600,
      isOngoing: true,
    });
    expect(multiplier).toBeLessThanOrEqual(HEADWAY_DEGRADATION_MAX_MULTIPLIER);
  });

  it("turns a 4-minute KJ peak headway into 13.4 minutes under a severe track fault", () => {
    const published = baseHeadwaySeconds("KJ", 8 * 3600, 1);
    expect(published).toBe(240);
    const degraded = degradedHeadwaySeconds(published as number, {
      severity: "SEVERE",
      issueType: "TRACK_FAULT",
      confidence: 1,
      atTime: 8 * 3600,
      isOngoing: true,
    });
    expect(degraded).toBeCloseTo(240 * 3.3625, 6);
    expect(degraded / 60).toBeCloseTo(13.45, 1);
  });

  it("computes the expected platform wait as half the headway", () => {
    expect(expectedPlatformWaitSeconds(240)).toBe(120);
    expect(expectedPlatformWaitSeconds(600)).toBe(300);
    expect(expectedPlatformWaitSeconds(-10)).toBe(0);
  });
});

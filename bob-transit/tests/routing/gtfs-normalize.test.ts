/**
 * Data-integrity tests for GTFS ingestion.
 *
 * The `route_id` column means a DIFFERENT thing in every file of this feed
 * (routes.txt: canonical; stops.txt: "MRT" for the Kajang line; stop_times.txt:
 * "AGL"/"KJL"/"SPL"/"MRL"/"SAL" long names). These tests fail loudly if any
 * spelling stops resolving, because a silent mis-join would corrupt the graph.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { parseCsvRecords } from "@/lib/gtfs/csv";
import {
  CANONICAL_LINE_IDS,
  canonicalNameKey,
  normalizeDisplayName,
  normalizeLineId,
  parseGtfsTime,
  toTransitMode,
} from "@/lib/gtfs/normalize";
import { GTFS_DIR } from "./helpers";

function routeIds(file: string): string[] {
  const records = parseCsvRecords(readFileSync(join(GTFS_DIR, file), "utf8"));
  return [...new Set(records.map((r) => r.route_id))].sort();
}

describe("route_id normalisation", () => {
  test("every route_id in every GTFS file maps to a canonical line id", () => {
    const files = ["routes.txt", "trips.txt", "stops.txt", "stop_times.txt"];
    for (const file of files) {
      const ids = routeIds(file);
      expect(ids.length, `${file} should contain route_ids`).toBeGreaterThan(0);
      for (const id of ids) {
        const canonical = normalizeLineId(id);
        expect(canonical, `${file}: route_id "${id}" did not normalise`).not.toBeNull();
        expect(CANONICAL_LINE_IDS).toContain(canonical as string);
      }
    }
  });

  test("the alias table matches what is actually in each file", () => {
    expect(routeIds("routes.txt")).toEqual([
      "AG",
      "BRT",
      "KGL",
      "KJ",
      "MR",
      "PH",
      "PYL",
      "SA",
    ]);
    // stops.txt calls the Kajang line "MRT".
    expect(routeIds("stops.txt")).toEqual([
      "AG",
      "BRT",
      "KJ",
      "MR",
      "MRT",
      "PH",
      "PYL",
      "SA",
    ]);
    // stop_times.txt uses the route_short_name spellings.
    expect(routeIds("stop_times.txt")).toEqual([
      "AGL",
      "BRT",
      "KGL",
      "KJL",
      "MRL",
      "PYL",
      "SAL",
      "SPL",
    ]);
  });

  test("trips.txt route_ids are already canonical (the only join key we trust)", () => {
    for (const id of routeIds("trips.txt")) {
      expect(normalizeLineId(id)).toBe(id);
    }
  });

  test("individual aliases", () => {
    expect(normalizeLineId("AGL")).toBe("AG");
    expect(normalizeLineId("KJL")).toBe("KJ");
    expect(normalizeLineId("SPL")).toBe("PH");
    expect(normalizeLineId("MRL")).toBe("MR");
    expect(normalizeLineId("SAL")).toBe("SA");
    expect(normalizeLineId("MRT")).toBe("KGL");
    expect(normalizeLineId("mrt")).toBe("KGL");
    expect(normalizeLineId("  kj  ")).toBe("KJ");
    expect(normalizeLineId("KTM")).toBeNull();
    expect(normalizeLineId("")).toBeNull();
  });

  test("stop_times.route_id and stops.route_id are never used as the join key", () => {
    // The join must be stop_times.trip_id -> trips.trip_id -> trips.route_id.
    // If someone joins on stop_times.route_id, PH would become "SPL".
    expect(normalizeLineId("SPL")).not.toBe("SPL");
    expect(normalizeLineId("SPL")).toBe("PH");
  });
});

describe("GTFS time parsing", () => {
  test("parses HH:MM:SS and HH:MM", () => {
    expect(parseGtfsTime("6:00:18")).toBe(21618);
    expect(parseGtfsTime("00:00:00")).toBe(0);
    expect(parseGtfsTime("23:59:59")).toBe(86399);
    expect(parseGtfsTime("6:00")).toBe(21600);
  });

  test("supports the >= 24:00 hours the fixture actually uses", () => {
    expect(parseGtfsTime("24:00:00")).toBe(86400);
  });

  test("rejects blank and malformed values", () => {
    expect(parseGtfsTime("")).toBeNull();
    expect(parseGtfsTime("nope")).toBeNull();
    expect(parseGtfsTime("12:99")).toBeNull();
  });
});

describe("display name normalisation", () => {
  test("title-cases words but preserves acronyms", () => {
    expect(normalizeDisplayName("AMPANG")).toBe("Ampang");
    expect(normalizeDisplayName("KLCC")).toBe("KLCC");
    expect(normalizeDisplayName("PWTC")).toBe("PWTC");
    expect(normalizeDisplayName("BANDARAYA - UOB")).toBe("Bandaraya - UOB");
    expect(normalizeDisplayName("DATO' MENTERI - SA SENTRAL")).toBe("Dato' Menteri - SA Sentral");
    expect(normalizeDisplayName("TAMAN TUN DR ISMAIL")).toBe("Taman Tun Dr Ismail");
    expect(normalizeDisplayName("SOUTH QUAY-USJ 1")).toBe("South Quay-USJ 1");
    expect(normalizeDisplayName("USJ 7")).toBe("USJ 7");
    expect(normalizeDisplayName("SunU-Monash")).toBe("SunU-Monash");
  });

  test("trims the fixture's stray whitespace", () => {
    expect(normalizeDisplayName("BUKIT BINTANG ")).toBe("Bukit Bintang");
    expect(normalizeDisplayName("SUNWAY LAGOON ")).toBe("Sunway Lagoon");
  });

  test("grouping keys ignore case, spacing and punctuation", () => {
    expect(canonicalNameKey("USJ 7")).toBe(canonicalNameKey("USJ7"));
    expect(canonicalNameKey("BUKIT BINTANG ")).toBe(canonicalNameKey("Bukit Bintang"));
    expect(canonicalNameKey("MASJID JAMEK")).toBe(canonicalNameKey("Masjid Jamek"));
    expect(canonicalNameKey("KL SENTRAL - REDONE")).not.toBe(canonicalNameKey("KL SENTRAL"));
  });
});

describe("mode mapping", () => {
  test("category column drives TransitMode", () => {
    expect(toTransitMode("LRT", 1, "KJ")).toBe("LRT");
    expect(toTransitMode("MRT", 1, "KGL")).toBe("MRT");
    expect(toTransitMode("MRL", 1, "MR")).toBe("MRL");
    expect(toTransitMode("BRT", 0, "BRT")).toBe("BRT");
  });

  test("falls back to the line id when category is absent", () => {
    expect(toTransitMode("", 1, "KGL")).toBe("MRT");
    expect(toTransitMode("", 1, "PYL")).toBe("MRT");
    expect(toTransitMode("", 1, "MR")).toBe("MRL");
    expect(toTransitMode("", 0, "BRT")).toBe("BRT");
    expect(toTransitMode("", 1, "KJ")).toBe("LRT");
  });
});

describe("CSV reader", () => {
  test("handles quoted fields, CRLF and a UTF-8 BOM", () => {
    const text = '\ufeffa,b,c\r\n1,"x,y",3\r\n"he said ""hi""",2,3\r\n';
    const rows = parseCsvRecords(text);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ a: "1", b: "x,y", c: "3" });
    expect(rows[1]).toEqual({ a: 'he said "hi"', b: "2", c: "3" });
  });
});

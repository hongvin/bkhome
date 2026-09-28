import { describe, expect, it } from "vitest";

import { aliasIndex, isCanonicalLineId, networkIndex } from "@/lib/signals";
import {
  editDistance,
  extractMentions,
  matchStationText,
  normalizeName,
  resolveLocation,
  typoBudget,
} from "@/lib/signals/entity-resolver";

const index = networkIndex();
const aliases = aliasIndex();

function resolve(text: string) {
  return resolveLocation(text, index, aliases);
}

describe("name normalisation", () => {
  it("folds the feed's punctuation and spacing quirks", () => {
    expect(normalizeName("DATO' KERAMAT")).toBe("DATO KERAMAT");
    expect(normalizeName("  BUKIT BINTANG  ")).toBe("BUKIT BINTANG");
    expect(normalizeName("SUNWAY-SETIA JAYA")).toBe("SUNWAY SETIA JAYA");
  });
});

describe("edit distance", () => {
  it("computes the restricted Damerau-Levenshtein distance", () => {
    expect(editDistance("kitten", "sitting")).toBe(3);
    expect(editDistance("masjidjamek", "masjidjamik")).toBe(1);
    expect(editDistance("", "abc")).toBe(3);
    expect(editDistance("ab", "ba")).toBe(1);
  });

  it("scales the typo budget with name length", () => {
    expect(typoBudget(3)).toBe(0);
    expect(typoBudget(6)).toBe(1);
    expect(typoBudget(12)).toBe(2);
  });
});

describe("station entity resolution against the real 187-station list", () => {
  it("resolves exact names", () => {
    expect(matchStationText("KLCC", aliases).stationIds).toEqual(["KJ10"]);
    expect(matchStationText("Phileo Damansara", aliases).stationIds).toEqual(["KG12"]);
    expect(matchStationText("Muzium Negara", aliases).stationIds).toEqual(["KG15"]);
  });

  it("resolves Malay/English variants and real colloquialisms", () => {
    expect(matchStationText("TTDI", aliases).stationIds).toEqual(["KG10"]);
    expect(matchStationText("Taman Tun Dr Ismail", aliases).stationIds).toEqual(["KG10"]);
    expect(matchStationText("TRX", aliases).stationIds).toEqual(["KG20", "PY23"]);
    expect(matchStationText("HKL", aliases).stationIds).toEqual(["PY18"]);
    expect(matchStationText("BTS", aliases).stationIds).toEqual(["SP15"]);
    expect(matchStationText("National Museum", aliases).stationIds).toEqual(["KG15"]);
    expect(matchStationText("Equine Park", aliases).stationIds).toEqual(["PY36"]);
  });

  it("handles the feed's own decorations and spacing", () => {
    expect(matchStationText("Bandaraya", aliases).stationIds).toEqual(["AG6", "SP6"]);
    expect(matchStationText("Bangsar", aliases).stationIds).toEqual(["KJ16"]);
    expect(matchStationText("USJ7", aliases).stationIds).toEqual(["BRT7", "KJ31"]);
    expect(matchStationText("USJ 7", aliases).stationIds).toEqual(["BRT7", "KJ31"]);
    expect(matchStationText("KL Sentral", aliases).stationIds).toEqual(["KJ15", "MR1"]);
  });

  it("tolerates misspellings", () => {
    expect(matchStationText("Masjid Jamik", aliases).stationIds).toEqual(["AG7", "KJ13", "SP7"]);
    expect(matchStationText("Kelana Jya", aliases).stationIds).toEqual(["KJ24"]);
    expect(matchStationText("Phileo Damansra", aliases).stationIds).toEqual(["KG12"]);
    expect(matchStationText("Taman Jya", aliases).stationIds).toEqual(["KJ20"]);
  });

  it("does not fuzzy-match short names into nonsense", () => {
    expect(matchStationText("XYZ", aliases).stationIds).toEqual([]);
    expect(matchStationText("Qwerty", aliases).stationIds).toEqual([]);
  });

  it("treats an interchange as ONE place across all its platforms", () => {
    const jamek = matchStationText("Masjid Jamek", aliases);
    expect(jamek.stationIds).toEqual(["AG7", "KJ13", "SP7"]);
    expect(jamek.placeKeys).toEqual(["PLACE:MASJID JAMEK"]);

    const bintang = matchStationText("Bukit Bintang", aliases);
    expect(bintang.stationIds).toEqual(["KG18A", "MR6"]);
    expect(bintang.placeKeys.length).toBe(1);
  });

  it("resolves an interchange claim to segments on every platform line", () => {
    const result = resolve("Gangguan di stesen Masjid Jamek, tren lambat.");
    expect(result.resolution).toBe("RESOLVED");
    expect(result.strategy).toBe("STATION");
    expect(result.stationIds).toEqual(["AG7", "KJ13", "SP7"]);
    expect(result.lineIds).toEqual(["AG", "KJ", "PH"]);
    expect(result.segmentIds.length).toBeGreaterThanOrEqual(6);
  });
});

describe("ambiguity — never silently pick one", () => {
  it("marks a genuinely ambiguous place UNRESOLVED with every candidate", () => {
    const result = resolve("Stesen Klang penuh sesak pagi ini.");
    expect(result.resolution).toBe("UNRESOLVED");
    expect(result.segmentIds).toEqual([]);
    expect(result.unresolvedCandidates.length).toBeGreaterThanOrEqual(6);
    expect(result.ambiguity).toBeDefined();
    expect(result.ambiguity?.candidates.length).toBe(3);
    const names = result.ambiguity?.candidates.map((c) => c.name).sort();
    expect(names).toEqual(["BANDAR BARU KLANG", "KLANG JAYA", "PASAR KLANG"]);
  });

  it("refuses to pick a segment for a line-wide claim", () => {
    const result = resolve("LALUAN KELANA JAYA terjejas teruk pagi ini.");
    expect(result.resolution).toBe("UNRESOLVED");
    expect(result.strategy).toBe("LINE");
    expect(result.lineIds).toEqual(["KJ"]);
    expect(result.segmentIds).toEqual([]);
    expect(result.unresolvedCandidates.length).toBe(72);
  });

  it("returns UNRESOLVED with no candidates when nothing is locatable", () => {
    const result = resolve("Semua rosak. Teruk sangat.");
    expect(result.resolution).toBe("UNRESOLVED");
    expect(result.segmentIds).toEqual([]);
    expect(result.unresolvedCandidates).toEqual([]);
    expect(result.locationConfidence).toBe(0);
  });

  it("reports an unknown station name rather than guessing", () => {
    const result = resolve("Stesen Taman Saga Indah tiada tren.");
    expect(result.resolution).toBe("UNRESOLVED");
    expect(result.segmentIds).toEqual([]);
  });
});

describe("segment claims", () => {
  it("resolves an explicit 'antara X dan Y' claim to both directions", () => {
    const result = resolve("Tren berhenti antara KLCC dan Ampang Park sejak 10 minit.");
    expect(result.resolution).toBe("RESOLVED");
    expect(result.strategy).toBe("SEGMENT_BETWEEN");
    expect(result.segmentIds).toEqual(["KJ:KJ10->KJ9", "KJ:KJ9->KJ10"]);
    expect(result.lineIds).toEqual(["KJ"]);
  });

  it("does not leak the interchange's other line into a line-specific claim", () => {
    const result = resolve("LRT Kelana Jaya: tren berhenti antara KLCC dan Ampang Park.");
    expect(result.segmentIds.every((s) => s.startsWith("KJ:"))).toBe(true);
  });

  it("resolves a multi-station span", () => {
    const result = resolve("Kerja landasan antara stesen Maluri dan Taman Pertama.");
    expect(result.resolution).toBe("RESOLVED");
    expect(result.segmentIds).toEqual(["KGL:KG22->KG23", "KGL:KG23->KG22"]);
    expect(result.lineIds).toEqual(["KGL"]);
  });
});

describe("mention extraction", () => {
  it("prefers the longest alias so AMPANG PARK is not read as the Ampang line", () => {
    const mentions = extractMentions("Stesen Ampang Park penuh sesak", aliases);
    expect(mentions.map((m) => m.text)).toEqual(["AMPANG PARK"]);
    expect(mentions[0].kind).toBe("STATION");
  });

  it("reads LRT X as a line claim and Stesen X as a station claim", () => {
    const line = extractMentions("LRT Kelana Jaya lambat", aliases);
    expect(line[0].kind).toBe("LINE");
    const station = extractMentions("Stesen Kelana Jaya penuh", aliases);
    expect(station[0].kind).toBe("STATION");
  });

  it("ignores bare generic words", () => {
    const mentions = extractMentions("Taman itu sangat cantik", aliases);
    expect(mentions).toEqual([]);
  });
});

describe("canonical line ids on the way out", () => {
  const texts = [
    "MRT Kajang line tergendala di Maluri",
    "MRT Laluan Kajang terjejas",
    "LRT Laluan Kelana Jaya lambat",
    "Monorel Kuala Lumpur rosak",
    "BRT Sunway terjejas",
    "LRT3 Shah Alam lambat",
    "LRT Ampang Sri Petaling tergendala",
    "Stesen Masjid Jamek sesak",
    "antara KLCC dan Ampang Park",
  ];

  it("never emits a non-canonical line id", () => {
    for (const text of texts) {
      const result = resolve(text);
      for (const lineId of result.lineIds) {
        expect(isCanonicalLineId(lineId), `${text} -> ${lineId}`).toBe(true);
      }
      for (const lineId of result.mentionedLineIds) {
        expect(isCanonicalLineId(lineId), `${text} -> mentioned ${lineId}`).toBe(true);
      }
      for (const segmentId of [...result.segmentIds, ...result.unresolvedCandidates]) {
        expect(isCanonicalLineId(segmentId.split(":")[0]), `${text} -> ${segmentId}`).toBe(true);
      }
    }
  });
});

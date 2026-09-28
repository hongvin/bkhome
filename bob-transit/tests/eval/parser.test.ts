/**
 * Parser tests against hand-written Malay snippets in the phrasing the real
 * archive uses. Every fixture is a committed text file under
 * `tests/eval/fixtures/`; nothing here touches the network or the PDF corpus.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  classifyDocument,
  estimateOnset,
  extractHeadline,
  extractIssueType,
  extractLineIds,
  extractSeverity,
  extractStations,
  extractTimeMentions,
  localDate,
  meridiemTo24,
  parseBodyDateline,
} from "@/eval/lib/parse";
import { stationIndex } from "@/eval/lib/stations";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): string =>
  readFileSync(path.join(HERE, "fixtures", name), "utf8");

const index = stationIndex();

describe("line extraction", () => {
  it("maps Laluan Kelana Jaya to KJ", () => {
    expect(extractLineIds(fixture("kelana-jaya-signal.txt"))).toEqual(["KJ"]);
  });

  it("expands the combined Ampang / Sri Petaling corridor to both lines", () => {
    expect(extractLineIds(fixture("ampang-sri-petaling-track.txt"))).toEqual(["AG", "PH"]);
  });

  it("maps Monorel to MR", () => {
    expect(extractLineIds(fixture("monorel-signal.txt"))).toEqual(["MR"]);
  });

  it("reads a bare Laluan Ampang as AG only", () => {
    expect(extractLineIds("Gangguan perkhidmatan LRT Laluan Ampang di Stesen Cahaya.")).toEqual([
      "AG",
    ]);
  });

  it("reads MRT Laluan Kajang and MRT Laluan Putrajaya", () => {
    const text = "MRT Laluan Kajang dan MRT Laluan Putrajaya mengalami kelewatan.";
    expect(extractLineIds(text)).toEqual(["KGL", "PYL"]);
  });

  it("returns nothing when no line is named", () => {
    expect(extractLineIds("Prasarana memaklumkan kadar penumpang meningkat.")).toEqual([]);
  });
});

describe("station extraction", () => {
  it("resolves two stations on the Kelana Jaya line to GTFS stop ids", () => {
    const stations = extractStations(
      "gangguan antara stesen LRT Taman Bahagia dan Stesen Ara Damansara",
      index,
    );
    const names = stations.map((s) => s.name);
    expect(names).toContain("TAMAN BAHAGIA");
    expect(names).toContain("ARA DAMANSARA");
    for (const s of stations) expect(s.stationId).toMatch(/^(KJ|AG|PH|KGL|PYL|MR|BRT|SA)\d+$/);
  });

  it("resolves Bandaraya and Masjid Jamek from the Ampang fixture", () => {
    const names = extractStations(fixture("ampang-sri-petaling-track.txt"), index).map(
      (s) => s.name,
    );
    expect(names).toContain("BANDARAYA");
    expect(names).toContain("MASJID JAMEK");
  });

  it("tolerates the corpus's misspellings via the alias table", () => {
    const stations = extractStations("gangguan di Stesen LRT Kentonmen", index);
    expect(stations.map((s) => s.name)).toContain("KENTOMEN");
  });

  it("does not turn 'Stesen LRT' alone into a station", () => {
    expect(extractStations("Perkhidmatan Stesen LRT terjejas.", index)).toEqual([]);
  });

  it("does not swallow the following conjunction into a station name", () => {
    const stations = extractStations("di Stesen Taman Jaya dan Stesen Taman Bahagia", index);
    expect(stations.map((s) => s.name)).toEqual(["TAMAN JAYA", "TAMAN BAHAGIA"]);
  });
});

describe("issue type extraction", () => {
  it("reads sistem semboyan as SIGNAL_FAULT, not DELAY, despite 'kelewatan'", () => {
    expect(extractIssueType(fixture("kelana-jaya-signal.txt"))).toBe("SIGNAL_FAULT");
  });

  it("reads kinked track / struktur jejambat as TRACK_FAULT", () => {
    expect(extractIssueType(fixture("ampang-sri-petaling-track.txt"))).toBe("TRACK_FAULT");
  });

  it("reads tren terkandas as VEHICLE_BREAKDOWN", () => {
    expect(extractIssueType(fixture("kelana-jaya-train-stranded.txt"))).toBe("VEHICLE_BREAKDOWN");
  });

  it("reads sistem isyarat as SIGNAL_FAULT", () => {
    expect(extractIssueType(fixture("monorel-signal.txt"))).toBe("SIGNAL_FAULT");
  });

  it("lets a named root cause beat the DELAY symptom", () => {
    const text =
      "Perkhidmatan mengalami kelewatan dan jejas jadual perjalanan akibat kerosakan landasan di Stesen PWTC.";
    expect(extractIssueType(text)).toBe("TRACK_FAULT");
  });

  it("keeps DELAY when no root cause is named", () => {
    expect(extractIssueType("Perkhidmatan mengalami kelewatan pada jadual perjalanan.")).toBe(
      "DELAY",
    );
  });

  it("reads lif dan eskalator as ELEVATOR_FAULT", () => {
    expect(extractIssueType("Lif dan eskalator di stesen tidak berfungsi.")).toBe("ELEVATOR_FAULT");
  });

  it("reads pokok tumbang as WEATHER", () => {
    expect(extractIssueType("Dahan pokok tumbang ke atas landasan tren monorel.")).toBe("WEATHER");
  });

  it("does not treat a stranded train as a blocked road", () => {
    expect(extractIssueType("Sebuah tren tersangkut di landasan.")).not.toBe("ROAD_BLOCKED");
  });

  it("still treats a stranded bus as a blocked road", () => {
    expect(extractIssueType("Sebuah bas tersangkut di struktur atas terowong.")).toBe("ROAD_BLOCKED");
  });

  it("falls back to UNKNOWN when nothing matches", () => {
    expect(extractIssueType("Prasarana mengumumkan sesuatu.")).toBe("UNKNOWN");
  });
});

describe("severity extraction", () => {
  it("rates a full suspension SEVERE", () => {
    expect(extractSeverity("Perkhidmatan dihentikan antara dua stesen.")).toBe("SEVERE");
  });

  it("rates gangguan perkhidmatan MAJOR", () => {
    expect(extractSeverity("Perkhidmatan mengalami gangguan perkhidmatan.")).toBe("MAJOR");
  });

  it("rates a plain delay MINOR", () => {
    expect(extractSeverity("Tren mengalami kelewatan 10 minit.")).toBe("MINOR");
  });
});

describe("dateline and time parsing", () => {
  it("parses the Malay dateline and infers a missing year", () => {
    const d = parseBodyDateline("KUALA LUMPUR, 27 Januari - Perkhidmatan...", 2023);
    expect(d?.date).toBe("2023-01-27");
  });

  it("parses an explicit dateline year", () => {
    expect(parseBodyDateline("KUALA LUMPUR, 9 Oktober 2022 – Ujian...", 2020)?.date).toBe(
      "2022-10-09",
    );
  });

  it("converts Malay meridiems to 24-hour time", () => {
    expect(meridiemTo24(8, "pagi")).toBe(8);
    expect(meridiemTo24(12, "pagi")).toBe(0);
    expect(meridiemTo24(12, "tengah hari")).toBe(12);
    expect(meridiemTo24(4, "petang")).toBe(16);
    expect(meridiemTo24(9, "malam")).toBe(21);
    expect(meridiemTo24(12, "tengah malam")).toBe(0);
  });

  it("classifies a disruption clock time as onset and a repair time as restore", () => {
    const mentions = extractTimeMentions(
      "Kejadian yang dilaporkan berlaku pada jam 8.16 pagi telah menyebabkan hanya satu landasan. " +
        "Perkhidmatan pulih sepenuhnya pada jam 1.26 petang.",
    );
    const onset = mentions.filter((m) => m.role === "onset");
    const restore = mentions.filter((m) => m.role === "restore");
    expect(onset.map((m) => m.surface)).toContain("jam 8.16 pagi");
    expect(restore.map((m) => m.surface)).toContain("jam 1.26 petang");
  });

  it("does not read a passenger figure as a clock time", () => {
    const mentions = extractTimeMentions("Seramai 1.27 juta penumpang direkodkan.");
    expect(mentions).toEqual([]);
  });
});

describe("onset estimation", () => {
  it("anchors an onset to the statement's own day", () => {
    const text = fixture("kelana-jaya-train-stranded.txt");
    const publishedAt = "2022-05-10T05:10:00.000Z"; // 13:10 +08
    const mentions = extractTimeMentions(text);
    const onset = estimateOnset(text, publishedAt, { date: "2022-05-10" }, mentions);
    expect(onset.basis).toBe("explicit_time");
    // 08:16 Asia/Kuala_Lumpur == 00:16 UTC.
    expect(onset.at).toBe("2022-05-10T00:16:00.000Z");
  });

  it("treats 'petang tadi' as earlier the same day, not yesterday", () => {
    const text =
      "KUALA LUMPUR, 7 Mei 2024 – Dahan pokok tumbang ke atas landasan yang berlaku pada jam 2.20 petang tadi.";
    const mentions = extractTimeMentions(text);
    const onset = estimateOnset(text, "2024-05-07T07:44:00.000Z", { date: "2024-05-07" }, mentions);
    expect(onset.at).toBe("2024-05-07T06:20:00.000Z"); // 14:20 +08
  });

  it("treats 'semalam' as the previous day", () => {
    const text =
      "KUALA LUMPUR, 23 Mac 2023 – Gangguan yang dilaporkan berlaku pada jam 6.56 petang itu berlaku petang semalam.";
    const mentions = extractTimeMentions(text);
    const onset = estimateOnset(text, "2023-03-22T16:57:00.000Z", { date: "2023-03-23" }, mentions);
    expect(onset.at).toBe("2023-03-22T10:56:00.000Z"); // 22 Mar 18:56 +08
  });

  it("never anchors an onset to a date after publication", () => {
    const text =
      "KUALA LUMPUR, 14 Mac 2022 – Perkhidmatan akan ditutup pada 1 April 2022 bagi kerja-kerja naik taraf.";
    const mentions = extractTimeMentions(text);
    const onset = estimateOnset(text, "2022-03-14T12:11:00.000Z", { date: "2022-03-14" }, mentions);
    expect(onset.basis).toBe("dateline_only");
    expect(Date.parse(onset.at)).toBeLessThanOrEqual(Date.parse("2022-03-14T12:11:00.000Z"));
  });

  it("localDate converts a UTC instant to the Asia/Kuala_Lumpur calendar day", () => {
    expect(localDate("2022-05-10T18:00:00.000Z")).toBe("2022-05-11");
    expect(localDate("2022-05-10T15:59:00.000Z")).toBe("2022-05-10");
  });
});

describe("document classification", () => {
  it("calls a disruption statement an INCIDENT", () => {
    expect(classifyDocument(fixture("kelana-jaya-train-stranded.txt")).kind).toBe("INCIDENT");
  });

  it("calls a campaign statement a NON_INCIDENT even though it names lines", () => {
    const c = classifyDocument(fixture("non-incident-campaign.txt"));
    expect(c.kind).toBe("NON_INCIDENT");
    expect(extractLineIds(fixture("non-incident-campaign.txt")).length).toBeGreaterThan(0);
  });

  it("does not force a disruption into the incident set when no line is named", () => {
    const c = classifyDocument(
      "Gangguan perkhidmatan bas Rapid KL di beberapa laluan di Lembah Klang hari ini.",
    );
    expect(c.kind).toBe("NON_INCIDENT");
    expect(c.reason).toContain("no identifiable rail line");
  });

  it("classifies a planned works notice as a PLANNED_SERVICE_CHANGE", () => {
    const text =
      "KUALA LUMPUR, 1 Januari 2023 – Kerja-kerja naik taraf sistem semboyan Laluan Kelana Jaya " +
      "akan dijalankan. Penjadualan semula kerja-kerja akan diumumkan. Perkhidmatan LRT Laluan Kelana Jaya " +
      "akan ditutup sementara.";
    expect(classifyDocument(text).kind).toBe("PLANNED_SERVICE_CHANGE");
  });

  it("treats a test-result announcement as a NON_INCIDENT", () => {
    const text =
      "KUALA LUMPUR, 11 November 2022 – Ujian menunjukkan petanda positif untuk LRT Laluan Kelana Jaya. " +
      "Perkhidmatan dijangka dibuka sepenuhnya.";
    expect(classifyDocument(text).kind).toBe("NON_INCIDENT");
  });

  it("flags an empty extraction as UNREADABLE", () => {
    expect(classifyDocument("   ").kind).toBe("UNREADABLE");
  });
});

describe("headline extraction", () => {
  it("keeps the caps headline and drops the SIARAN MEDIA banner", () => {
    const headline = extractHeadline(fixture("ampang-sri-petaling-track.txt"));
    expect(headline).toContain("GANGGUAN PERKHIDMATAN");
    expect(headline).not.toContain("KUALA LUMPUR");
    expect(headline).not.toMatch(/^SIARAN MEDIA/);
  });

  it("works when the whole header collapses onto one line", () => {
    const headline = extractHeadline(
      "SIARAN MEDIA Untuk Siaran Segera GANGGUAN PERKHIDMATAN LRT LALUAN KELANA JAYA KUALA LUMPUR, 1 Januari 2023 – Perkhidmatan...",
    );
    expect(headline).toContain("GANGGUAN PERKHIDMATAN");
    expect(headline).not.toContain("SIARAN MEDIA");
  });
});

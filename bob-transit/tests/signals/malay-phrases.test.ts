import { describe, expect, it } from "vitest";

import { foldMalay, parseMalayDisruptionPhrases } from "@/lib/agents/ingest/malay-phrases";

const parse = (text: string) => parseMalayDisruptionPhrases(text, "2024-03-05T09:00:00+08:00");

describe("Bahasa Malaysia disruption phrase parser", () => {
  it("folds text without losing sentence boundaries", () => {
    expect(foldMalay("Tren  rosak!! di KLCC.")).toBe("TREN ROSAK!! DI KLCC.");
    expect(foldMalay("Dato' Keramat")).toBe("DATO' KERAMAT");
  });

  it("recognises RapidKL's own operational vocabulary", () => {
    expect(parse("GANGGUAN PERKHIDMATAN LRT LALUAN KELANA JAYA").issueType).toBe("DELAY");
    expect(parse("Perkhidmatan tren terjejas di beberapa stesen").issueType).toBe("DELAY");
    expect(parse("Sistem isyarat rosak di stesen KLCC").issueType).toBe("SIGNAL_FAULT");
    expect(parse("Masalah sistem isyarat di antara KLCC dan Ampang Park").issueType).toBe("SIGNAL_FAULT");
    expect(parse("TREN TERKANDAS di Taman Jaya").issueType).toBe("VEHICLE_BREAKDOWN");
    expect(parse("Landasan rosak antara Maluri dan Taman Pertama").issueType).toBe("TRACK_FAULT");
    expect(parse("Gangguan suis di landasan").issueType).toBe("TRACK_FAULT");
  });

  it("distinguishes door, lift, crowding, weather and road faults", () => {
    expect(parse("Pintu tren tidak dapat ditutup").issueType).toBe("DOOR_FAULT");
    expect(parse("Lif rosak di stesen KLCC").issueType).toBe("ELEVATOR_FAULT");
    expect(parse("Platform penuh sesak pagi ini").issueType).toBe("CROWDING");
    expect(parse("Hujan lebat dan banjir di Jalan Lagoon Selatan").issueType).toBe("WEATHER");
    expect(parse("Kemalangan di jalan raya, jalan ditutup").issueType).toBe("ROAD_BLOCKED");
    expect(parse("Gangguan teknikal, punca belum dikenal pasti").issueType).toBe("UNKNOWN");
  });

  it("picks the most specific issue when several phrases appear", () => {
    const result = parse("GANGGUAN PERKHIDMATAN: sistem isyarat rosak, tren lambat 30 minit.");
    expect(result.issueType).toBe("SIGNAL_FAULT");
    expect(result.hits.map((h) => h.canonical)).toContain("GANGGUAN PERKHIDMATAN");
  });

  it("reads severity cues and floors them at the issue type default", () => {
    expect(parse("Perkhidmatan dihentikan sepenuhnya di semua stesen").severity).toBe("SEVERE");
    expect(parse("Keadaan sangat teruk, tren tak bergerak").severity).toBe("MAJOR");
    expect(parse("Kelewatan sedikit sahaja").severity).toBe("MINOR");
    expect(parse("Makluman: ada gangguan kecil").severity).toBe("INFO");
  });

  it("separates recovery notices from disruption notices", () => {
    const recovered = parse("Perkhidmatan LRT Laluan Kelana Jaya kembali beroperasi seperti biasa.");
    expect(recovered.recovery).toBe(true);
    expect(recovered.ongoing).toBe(false);

    const live = parse("LRT Kelana Jaya masih belum pulih sejak pagi.");
    expect(live.recovery).toBe(false);
    expect(live.ongoing).toBe(true);
  });

  it("tells an ongoing incident from a stale reference", () => {
    const stale = parse("Throwback 2022: LRT Kelana Jaya tutup 2 minggu.");
    expect(stale.historical).toBe(true);
    expect(stale.ongoing).toBe(false);
    expect(stale.impliedDaysAgo).toBeGreaterThan(300);

    const lastWeek = parse("Minggu lepas LRT Kelana Jaya ada gangguan isyarat di KLCC. Sekarang dah ok ke belum?");
    expect(lastWeek.historical).toBe(true);
    // "Sekarang" is a bare time adverb and must NOT make a past-tense post live.
    expect(lastWeek.ongoing).toBe(false);

    const ongoing = parse("Masih belum pulih, tren tak bergerak sejak 20 minit.");
    expect(ongoing.ongoing).toBe(true);
  });

  it("extracts LALUAN and STESEN mentions", () => {
    const result = parse("GANGGUAN PERKHIDMATAN DI LALUAN KELANA JAYA. Sila guna STESEN KLCC.");
    expect(result.lineMentions).toContain("KELANA JAYA");
    expect(result.stationMentions).toContain("KLCC");
  });

  it("extracts an 'antara X dan Y' span without swallowing the next clause", () => {
    expect(parse("Tren berhenti antara KLCC dan Ampang Park sejak 10 minit.").betweenMention).toEqual([
      "KLCC",
      "AMPANG PARK",
    ]);
    expect(
      parse("Masalah isyarat di antara stesen KLCC dan Ampang Park. Perkhidmatan dilambatkan.").betweenMention,
    ).toEqual(["KLCC", "AMPANG PARK"]);
    expect(parse("Tren tak bergerak di stesen KLCC.").betweenMention).toBeNull();
  });

  it("detects alternative-service notices", () => {
    expect(parse("Bas perantara percuma disediakan.").alternativeService).toBe(true);
    expect(parse("Tren berhenti biasa sahaja.").alternativeService).toBe(false);
  });

  it("flags road or weather phrasing even with no rail station", () => {
    expect(parse("Lebuhraya ditutup akibat banjir.").roadOrWeather).toBe(true);
  });

  it("never invents an issue type from unrelated text", () => {
    const result = parse("Selamat pagi semua, cuaca hari ini cantik.");
    expect(result.issueType).toBe("UNKNOWN");
    expect(result.hits.length).toBe(0);
    expect(result.issueTypeConfidence).toBe(0);
  });

  it("works on the Manglish mix people actually write", () => {
    const result = parse("Signal fault kat LRT Kelana Jaya line. Train stuck, almost 20 minutes already.");
    expect(result.issueType).toBe("SIGNAL_FAULT");
    expect(result.ongoing).toBe(false);
  });
});

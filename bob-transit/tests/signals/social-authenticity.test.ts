import { describe, expect, it } from "vitest";

import {
  JUNK_QUALITY_THRESHOLD,
  assessSocialAuthenticity,
} from "@/lib/agents/ingest/social-authenticity";
import { parseMalayDisruptionPhrases } from "@/lib/agents/ingest/malay-phrases";

function assess(text: string, extra: Record<string, unknown> = {}) {
  return assessSocialAuthenticity({
    text,
    parse: parseMalayDisruptionPhrases(text, "2024-03-05T09:00:00+08:00"),
    ...extra,
  });
}

describe("sarcasm detection", () => {
  it("catches mock praise about a real line", () => {
    const result = assess("TERBAIK LA RAPID KL. LRT Kelana Jaya delay 40 minit, memang world class service. /s");
    expect(result.sarcasmScore).toBeGreaterThanOrEqual(JUNK_QUALITY_THRESHOLD);
    expect(result.qualityMultiplier).toBeLessThan(JUNK_QUALITY_THRESHOLD);
    expect(result.reasons.join(" ")).toMatch(/sarcast/i);
  });

  it("catches ironic congratulation", () => {
    const result = assess("Tahniah Rapid KL, rekod baru dunia! LRT rosak tapi masih boleh senyum.");
    expect(result.sarcasmScore).toBeGreaterThan(0);
    expect(result.qualityMultiplier).toBeLessThan(JUNK_QUALITY_THRESHOLD);
  });

  it("does not treat genuine distress as sarcasm", () => {
    const result = assess("Dah 40 minit terperangkap dalam tren, tak boleh keluar. Tolonglah.");
    expect(result.sarcasmScore).toBeLessThan(JUNK_QUALITY_THRESHOLD);
    expect(result.qualityMultiplier).toBeGreaterThan(JUNK_QUALITY_THRESHOLD);
  });

  it("does not treat crying or angry emoji as sarcasm", () => {
    const result = assess("Tren tak bergerak 30 minit dah 😭😭 penat sangat");
    expect(result.sarcasmScore).toBeLessThan(JUNK_QUALITY_THRESHOLD);
  });
});

describe("joke detection", () => {
  it("catches absurd-alternative jokes", () => {
    const result = assess("Aku rasa nak beli basikal. LRT Kelana Jaya macam ni lagi cepat jalan kaki 😂😂 #prank");
    expect(result.jokeScore).toBeGreaterThanOrEqual(JUNK_QUALITY_THRESHOLD);
    expect(result.qualityMultiplier).toBeLessThan(JUNK_QUALITY_THRESHOLD);
  });

  it("catches absurd transport jokes", () => {
    const result = assess("LRT Kelana Jaya sekarang macam kapal karam. Naik perahu pun boleh sampai lebih awal.");
    expect(result.qualityMultiplier).toBeLessThan(JUNK_QUALITY_THRESHOLD);
  });
});

describe("stale-incident quoting", () => {
  it("rejects a throwback post", () => {
    const result = assess("Throwback 2022: LRT Kelana Jaya tutup 2 minggu, bas perantara percuma. Ingat tak? #tbt");
    expect(result.staleQuoteScore).toBeGreaterThanOrEqual(JUNK_QUALITY_THRESHOLD);
    expect(result.qualityMultiplier).toBeLessThan(JUNK_QUALITY_THRESHOLD);
    expect(result.reasons.join(" ")).toMatch(/stale|old-incident/i);
  });

  it("rejects a screenshot of an old closure", () => {
    const result = assess(
      "Screenshot dari group WhatsApp: 'GANGGUAN PERKHIDMATAN LRT LALUAN KELANA JAYA — 2021'. Sila ambil perhatian.",
    );
    expect(result.qualityMultiplier).toBeLessThan(JUNK_QUALITY_THRESHOLD);
  });

  it("keeps a past reference LIVE when the text says the problem is ongoing", () => {
    const result = assess("Macam minggu lepas, LRT Kelana Jaya masih belum pulih sampai sekarang.");
    expect(result.qualityMultiplier).toBeGreaterThanOrEqual(JUNK_QUALITY_THRESHOLD);
    expect(result.reasons.join(" ")).toMatch(/ongoing/i);
  });
});

describe("repost detection", () => {
  it("recognises an RT prefix and attributes to the original", () => {
    const result = assess("RT @ina: MRT Kajang line tergendala di stesen Maluri.", {
      authorId: "tw:bot",
      authorHandle: "@bot",
      originalAuthorId: "tw:ina",
      originalAuthorHandle: "@ina",
      repostOfId: "orig",
    });
    expect(result.isRepost).toBe(true);
    expect(result.effectiveAuthorId).toBe("tw:ina");
    expect(result.effectiveAuthorHandle).toBe("@ina");
    // A repost is not junk — it is simply not a NEW witness.
    expect(result.qualityMultiplier).toBe(1);
    expect(result.reasons.join(" ")).toMatch(/repost/i);
  });

  it("recognises a repost from text alone", () => {
    const result = assess("Repost: MRT Kajang line tergendala. Credit: @ina");
    expect(result.isRepost).toBe(true);
    expect(result.repostScore).toBeGreaterThanOrEqual(0.5);
  });

  it("does not flag an ordinary post as a repost", () => {
    const result = assess("LRT Kelana Jaya lambat 20 minit di KLCC pagi ini.");
    expect(result.isRepost).toBe(false);
    expect(result.repostScore).toBe(0);
  });
});

describe("quality multiplier", () => {
  it("stays at 1 for a clean report", () => {
    const result = assess("Tren LRT Kelana Jaya berhenti di Ampang Park sejak 15 minit.");
    expect(result.qualityMultiplier).toBe(1);
    expect(result.reasons[0]).toMatch(/no irony/i);
  });

  it("never returns zero, so a partially suspicious post still counts a little", () => {
    const result = assess("TERBAIK LA RAPID KL, tahniah, memang efisien. LRT rosak.");
    expect(result.qualityMultiplier).toBeGreaterThan(0);
    expect(result.qualityMultiplier).toBeLessThan(JUNK_QUALITY_THRESHOLD);
  });
});

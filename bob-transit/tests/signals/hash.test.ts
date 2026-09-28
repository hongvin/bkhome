import { describe, expect, it } from "vitest";

import { sha256Bytes, sha256Hex } from "@/lib/signals/hash";
import { contentHashOf, normalizeSourceText } from "@/lib/agents/ingest/normalize";

describe("sha256", () => {
  it("matches the NIST vectors", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(sha256Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")).toBe(
      "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
    );
  });

  it("handles multi-block input", () => {
    const million = "a".repeat(1_000_000);
    expect(sha256Hex(million)).toBe(
      "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0",
    );
  });

  it("produces 32 raw bytes", () => {
    expect(sha256Bytes(new TextEncoder().encode("x")).length).toBe(32);
  });
});

describe("source text normalisation", () => {
  it("strips RT scaffolding and URLs so a repost hashes like its original", () => {
    const original = "LRT Kelana Jaya tergendala di KLCC.";
    const repost = "RT @ali_kl: LRT Kelana Jaya tergendala di KLCC. https://t.co/abc123";
    expect(normalizeSourceText(repost)).toBe(original);
    expect(contentHashOf(repost)).toBe(contentHashOf(original));
  });

  it("strips leading @mentions", () => {
    expect(normalizeSourceText("@ali_kl @siti_na LRT rosak")).toBe("LRT rosak");
  });

  it("removes zero-width characters", () => {
    expect(normalizeSourceText("LRT\u200brosak")).toBe("LRTrosak");
  });
});

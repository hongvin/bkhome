import { describe, expect, it } from "vitest";

import { SOURCE_CLASSES } from "@/lib/contracts";
import { loadCorpus, loadScenario, scenarioRecords } from "@/lib/agents/ingest/corpus";

const corpus = loadCorpus();

describe("committed corpus", () => {
  it("loads entirely offline from committed fixtures", () => {
    expect(corpus.records.length).toBeGreaterThanOrEqual(30);
    expect(corpus.scenarios.length).toBeGreaterThanOrEqual(12);
    expect(corpus.version).toBe("1.0.0");
  });

  it("uses only frozen source classes", () => {
    for (const record of corpus.records) {
      expect(SOURCE_CLASSES).toContain(record.sourceClass);
    }
  });

  it("has unique ids and parseable timestamps", () => {
    const ids = corpus.records.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const record of corpus.records) {
      expect(Number.isFinite(Date.parse(record.publishedAt)), record.id).toBe(true);
      expect(Number.isFinite(Date.parse(record.retrievedAt)), record.id).toBe(true);
      expect(record.retrievedAt >= record.publishedAt, record.id).toBe(true);
      expect(record.text.trim().length).toBeGreaterThan(0);
    }
  });

  it("attributes every social post to a stable author identity", () => {
    for (const record of corpus.records) {
      if (record.sourceClass !== "SOCIAL") continue;
      expect(record.authorId, record.id).toBeDefined();
    }
  });

  it("makes every repost attributable to a single original author", () => {
    const reposts = corpus.records.filter((r) => r.originalAuthorId !== undefined);
    expect(reposts.length).toBeGreaterThanOrEqual(5);
    for (const repost of reposts) {
      expect(repost.repostOfId, repost.id).toBeDefined();
      expect(corpus.byId.has(repost.repostOfId!), repost.id).toBe(true);
      const original = corpus.byId.get(repost.repostOfId!)!;
      expect(original.authorId, repost.id).toBe(repost.originalAuthorId);
      // A repost is not its own witness.
      expect(repost.authorId).not.toBe(repost.originalAuthorId);
    }
  });

  it("covers the real failure modes the Verifier must survive", () => {
    const allText = corpus.records.map((r) => r.text).join("\n");
    expect(allText).toMatch(/TERBAIK LA/);            // mock praise / sarcasm
    expect(allText).toMatch(/basikal|kapal|perahu/);  // absurd-alternative jokes
    expect(allText).toMatch(/Throwback|tbt/i);        // stale quoting
    expect(allText).toMatch(/Screenshot/i);           // screenshot of an old incident
    expect(allText).toMatch(/RT @/);                  // reposts
    expect(allText).toMatch(/antara KLCC dan Ampang Park/); // genuine multi-witness
    expect(allText).toMatch(/KENYATAAN|memaklumkan|Status terkini/); // official register
  });

  it("gives every scenario a pinned now and a reachable source list", () => {
    for (const scenario of corpus.scenarios) {
      expect(Number.isFinite(Date.parse(scenario.now)), scenario.id).toBe(true);
      for (const sourceId of scenario.sourceIds) {
        expect(corpus.byId.has(sourceId), `${scenario.id} -> ${sourceId}`).toBe(true);
      }
    }
  });

  it("resolves scenario records in the recorded order", () => {
    const records = scenarioRecords("kj-signal-fault-cluster");
    expect(records.map((r) => r.id)).toEqual(["soc-kj-sig-001", "soc-kj-sig-002", "soc-kj-sig-003"]);
  });

  it("throws on an unknown scenario rather than returning nothing", () => {
    expect(() => loadScenario("does-not-exist")).toThrow(/unknown corpus scenario/);
  });

  it("contains no network references on the demo path", () => {
    for (const record of corpus.records) {
      if (record.url === undefined) continue;
      // Fixtures may record provenance URLs, but they must not be fetchable
      // endpoints the demo could accidentally depend on.
      expect(record.url, record.id).toMatch(/^https:\/\/example\.invalid\//);
    }
  });
});

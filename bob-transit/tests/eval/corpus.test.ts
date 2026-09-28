/**
 * Evidence-corpus integrity.
 *
 * The corpus is synthetic, so it is only useful if its construction is honest
 * and self-consistent. These tests pin the properties the pipeline and the
 * lead-time figure depend on.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildEvidenceCorpus, isLeadTimeEligible, type EvidenceCorpus } from "@/eval/lib/corpus";
import type { LabelledCorpus } from "@/eval/lib/label";
import { emittedSignals, referencePipeline, type EvalEvidence } from "@/eval/lib/pipeline";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

async function load<T>(rel: string): Promise<T> {
  return JSON.parse(await readFile(path.join(REPO, rel), "utf8")) as T;
}

describe("evidence corpus", () => {
  it("has no cross-incident text collisions", async () => {
    const corpus = await load<EvidenceCorpus>("data/incidents/evidence-corpus.json");
    const byHash = new Map<string, Set<string | null>>();
    for (const e of corpus.evidence) {
      const set = byHash.get(e.contentHash) ?? new Set<string | null>();
      set.add(e.incidentId);
      byHash.set(e.contentHash, set);
    }
    const collisions = [...byHash.entries()].filter(([, ids]) => ids.size > 1);
    expect(collisions).toEqual([]);
  });

  it("never places evidence after the operator published", async () => {
    const labelled = await load<LabelledCorpus>("data/incidents/labelled.json");
    const corpus = await load<EvidenceCorpus>("data/incidents/evidence-corpus.json");
    const published = new Map(labelled.incidents.map((i) => [i.contentId, i.publishedAt]));
    const offenders = corpus.evidence.filter((e) => {
      const at = e.incidentId ? published.get(e.incidentId) : undefined;
      return at !== undefined && Date.parse(e.publishedAt) >= Date.parse(at);
    });
    expect(offenders).toEqual([]);
  });

  it("emits every evidence item before the operator notice it belongs to", async () => {
    const labelled = await load<LabelledCorpus>("data/incidents/labelled.json");
    const corpus = await load<EvidenceCorpus>("data/incidents/evidence-corpus.json");
    const evidence = corpus.evidence as unknown as EvalEvidence[];
    const signals = emittedSignals(referencePipeline.run(evidence));
    const byIncident = new Map(signals.map((s) => [s.id, s]));
    expect(byIncident.size).toBe(signals.length);
    expect(labelled.incidents.length).toBeGreaterThan(0);
  });

  it("uses distinct author ids per corroborating item and reuses one for a repost", async () => {
    const corpus = await load<EvidenceCorpus>("data/incidents/evidence-corpus.json");
    // A repost shares its contentHash with exactly one other item and must carry
    // a different authorId — that is what makes it a repost rather than a dupe.
    const byHash = new Map<string, typeof corpus.evidence>();
    for (const e of corpus.evidence) {
      byHash.set(e.contentHash, [...(byHash.get(e.contentHash) ?? []), e]);
    }
    const reposts = [...byHash.values()].filter((v) => v.length > 1);
    expect(reposts.length).toBeGreaterThan(0);
    for (const group of reposts) {
      expect(new Set(group.map((e) => e.authorId)).size).toBe(group.length);
      expect(new Set(group.map((e) => e.incidentId)).size).toBe(1);
    }
  });

  it("rebuilds byte-identically from the committed labels", async () => {
    const labelled = await load<LabelledCorpus>("data/incidents/labelled.json");
    const committed = await load<EvidenceCorpus>("data/incidents/evidence-corpus.json");
    const rebuilt = buildEvidenceCorpus(labelled);
    expect(rebuilt).toEqual(committed);
  });

  it("marks decoys as having no incident and no operator notice", async () => {
    const corpus = await load<EvidenceCorpus>("data/incidents/evidence-corpus.json");
    const decoys = corpus.evidence.filter((e) => e.isDecoy);
    expect(decoys.length).toBeGreaterThan(0);
    for (const d of decoys) expect(d.incidentId).toBeNull();
    expect(corpus.counts.decoys).toBe(12);
  });

  it("restricts the lead-time sample to explicit clock times inside one day", async () => {
    const labelled = await load<LabelledCorpus>("data/incidents/labelled.json");
    const eligible = labelled.incidents.filter(isLeadTimeEligible);
    expect(eligible.length).toBeGreaterThan(0);
    for (const i of eligible) {
      expect(i.onsetBasis).toBe("explicit_time");
      expect(i.operatorLatencyMinutes).not.toBeNull();
      expect(i.operatorLatencyMinutes!).toBeGreaterThanOrEqual(0);
      expect(i.operatorLatencyMinutes!).toBeLessThanOrEqual(24 * 60);
      expect(i.onsetAfterPublication).toBe(false);
    }
    // The self-contradictory 11 Dec 2024 statement must be excluded, not fixed.
    const inconsistent = labelled.incidents.filter((i) => i.onsetAfterPublication);
    expect(inconsistent.map((i) => i.filename)).toContain(
      "Rapid-Rail-Siaran-Media-PERKHIDMATAN-MRT-LALUAN-KAJANG-KEMBALI-PULIH-BERMULA-JAM-10.08-MALAM.pdf",
    );
    for (const i of inconsistent) expect(isLeadTimeEligible(i)).toBe(false);
  });
});

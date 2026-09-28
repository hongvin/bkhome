import { describe, expect, it } from "vitest";

import type { DisruptionSignal } from "@/lib/contracts";
import { runIngestAgent } from "@/lib/agents/ingest/agent";
import { loadCorpus, scenarioRecords } from "@/lib/agents/ingest/corpus";
import { runVerifyAgent, signalsForScenario } from "@/lib/agents/verify/agent";
import { REALTIME_CHANNEL_CAP } from "@/lib/signals/calibration";
import { collapseReposts, distinctSocialAuthors } from "@/lib/signals/dedupe";
import type { VerificationResult } from "@/lib/agents/verify/agent";

const corpus = loadCorpus();

interface ScenarioExpect {
  signalCount?: number;
  issueType?: string;
  resolution?: string;
  minConfidence?: number;
  maxConfidence?: number;
  band?: string;
  socialDistinctAuthors?: number;
  officialSources?: number;
  status?: string;
  minSegmentCount?: number;
  segmentIds?: string[];
  lineIds?: string[];
  minUnresolvedCandidates?: number;
  unresolvedCandidateCount?: number;
  minLeadTimeMinutes?: number;
  maxLeadTimeMinutes?: number;
  operatorNotifiedAt?: string;
  allRejected?: boolean;
  maxQualityMultiplier?: number;
  distinctSocialAuthorsAfterCollapse?: number;
  realtimeChannelCap?: number;
  officialDenialApplied?: boolean;
}

function checkScenario(id: string): { result: VerificationResult; expect: ScenarioExpect } {
  const scenario = corpus.scenarioById.get(id);
  expect(scenario, `scenario ${id} missing`).toBeDefined();
  const records = scenarioRecords(id);
  const result = runVerifyAgent({ records, now: scenario!.now });
  const expectSpec = scenario!.expect as ScenarioExpect;

  if (expectSpec.signalCount !== undefined) {
    expect(result.signals.length, `${id}: signalCount`).toBe(expectSpec.signalCount);
  }

  if (expectSpec.allRejected) {
    expect(result.signals.length, `${id}: allRejected`).toBe(0);
    expect(result.rejected.length, `${id}: rejected clusters`).toBeGreaterThan(0);
  }

  if (expectSpec.maxQualityMultiplier !== undefined) {
    const { candidates } = runIngestAgent({ records, now: scenario!.now });
    const worst = Math.max(...candidates.map((c) => c.authenticity.qualityMultiplier));
    expect(worst, `${id}: maxQualityMultiplier`).toBeLessThanOrEqual(expectSpec.maxQualityMultiplier);
  }

  if (expectSpec.distinctSocialAuthorsAfterCollapse !== undefined) {
    const { candidates } = runIngestAgent({ records, now: scenario!.now });
    const summary = distinctSocialAuthors(collapseReposts(candidates).unique);
    expect(summary.authors.length, `${id}: distinct authors after collapse`).toBe(
      expectSpec.distinctSocialAuthorsAfterCollapse,
    );
  }

  if (expectSpec.realtimeChannelCap !== undefined) {
    expect(expectSpec.realtimeChannelCap).toBe(REALTIME_CHANNEL_CAP);
  }

  if (expectSpec.officialDenialApplied) {
    expect(result.rejected.some((r) => /official source reports normal service/.test(r.reason))).toBe(true);
  }

  for (const signal of result.signals) {
    const where = `${id}/${signal.id}`;
    if (expectSpec.issueType !== undefined) expect(signal.issueType, `${where}: issueType`).toBe(expectSpec.issueType);
    if (expectSpec.resolution !== undefined) expect(signal.resolution, `${where}: resolution`).toBe(expectSpec.resolution);
    if (expectSpec.band !== undefined) expect(signal.confidence.band, `${where}: band`).toBe(expectSpec.band);
    if (expectSpec.status !== undefined) expect(signal.status, `${where}: status`).toBe(expectSpec.status);
    if (expectSpec.minConfidence !== undefined) {
      expect(signal.confidence.value, `${where}: minConfidence`).toBeGreaterThanOrEqual(expectSpec.minConfidence);
    }
    if (expectSpec.maxConfidence !== undefined) {
      expect(signal.confidence.value, `${where}: maxConfidence`).toBeLessThanOrEqual(expectSpec.maxConfidence);
    }
    if (expectSpec.socialDistinctAuthors !== undefined) {
      expect(signal.corroboratingSources.socialDistinctAuthors, `${where}: authors`).toBe(
        expectSpec.socialDistinctAuthors,
      );
    }
    if (expectSpec.officialSources !== undefined) {
      expect(signal.corroboratingSources.official, `${where}: official`).toBe(expectSpec.officialSources);
    }
    if (expectSpec.minSegmentCount !== undefined) {
      expect(signal.segmentIds.length, `${where}: minSegmentCount`).toBeGreaterThanOrEqual(
        expectSpec.minSegmentCount,
      );
    }
    if (expectSpec.segmentIds !== undefined) expect(signal.segmentIds, `${where}: segmentIds`).toEqual(expectSpec.segmentIds);
    if (expectSpec.lineIds !== undefined) expect(signal.lineIds, `${where}: lineIds`).toEqual(expectSpec.lineIds);
    if (expectSpec.minUnresolvedCandidates !== undefined) {
      expect(signal.unresolvedCandidates?.length ?? 0, `${where}: unresolved candidates`).toBeGreaterThanOrEqual(
        expectSpec.minUnresolvedCandidates,
      );
    }
    if (expectSpec.unresolvedCandidateCount !== undefined) {
      expect(signal.unresolvedCandidates?.length ?? 0, `${where}: unresolved candidate count`).toBe(
        expectSpec.unresolvedCandidateCount,
      );
    }
    if (expectSpec.operatorNotifiedAt !== undefined) {
      expect(signal.operatorNotifiedAt, `${where}: operatorNotifiedAt`).toBe(expectSpec.operatorNotifiedAt);
    }
    if (expectSpec.minLeadTimeMinutes !== undefined) {
      expect(signal.leadTimeMinutes ?? -1, `${where}: minLeadTime`).toBeGreaterThanOrEqual(
        expectSpec.minLeadTimeMinutes,
      );
    }
    if (expectSpec.maxLeadTimeMinutes !== undefined) {
      expect(signal.leadTimeMinutes ?? Number.MAX_SAFE_INTEGER, `${where}: maxLeadTime`).toBeLessThanOrEqual(
        expectSpec.maxLeadTimeMinutes,
      );
    }
  }

  return { result, expect: expectSpec };
}

describe("committed corpus scenarios", () => {
  it("has a scenario for every required failure mode", () => {
    const ids = corpus.scenarios.map((s) => s.id);
    expect(ids).toContain("kj-signal-fault-cluster");
    expect(ids).toContain("kj-official-confirmation");
    expect(ids).toContain("repost-storm-one-author");
    expect(ids).toContain("sarcasm-and-jokes");
    expect(ids).toContain("stale-throwback");
    expect(ids).toContain("ambiguous-klang");
    expect(ids).toContain("line-wide-kelana-jaya");
    expect(ids).toContain("single-anecdote-silence");
    expect(ids).toContain("realtime-only-is-weak");
    expect(ids).toContain("official-denial-suppresses-noise");
    expect(ids).toContain("empty-corpus");
  });

  for (const scenario of loadCorpus().scenarios) {
    it(`satisfies the recorded expectation: ${scenario.id}`, () => {
      checkScenario(scenario.id);
    });
  }

  it("is deterministic across repeated runs", () => {
    const a = checkScenario("kj-official-confirmation").result.signals;
    const b = checkScenario("kj-official-confirmation").result.signals;
    expect(a).toEqual(b);
  });
});

/* ------------------------------------------------------------------ *
 * REQUIRED EVIDENCE: a full trace with confidence at each hop
 * ------------------------------------------------------------------ */

function renderTrace(signal: DisruptionSignal): string {
  const lines: string[] = [];
  lines.push(`  signal ${signal.id}  status=${signal.status}  ${signal.issueType}/${signal.severity}`);
  lines.push(
    `  segments=[${signal.segmentIds.join(", ") || "(none)"}]  lineIds=[${signal.lineIds.join(", ")}]` +
      (signal.unresolvedCandidates ? `  unresolvedCandidates=${signal.unresolvedCandidates.length}` : ""),
  );
  lines.push(
    `  corroboration: official=${signal.corroboratingSources.official}` +
      ` socialDistinctAuthors=${signal.corroboratingSources.socialDistinctAuthors}` +
      ` realtime=${signal.corroboratingSources.realtimeObservations}`,
  );
  for (const hop of signal.provenance) {
    lines.push(`  ${hop.hop.padEnd(7)} confidence=${hop.confidence.toFixed(3)}  ${hop.summary}`);
  }
  lines.push(`  reasoning: ${signal.reasoning}`);
  return lines.join("\n");
}

describe("REQUIRED EVIDENCE — confidence at each hop", () => {
  it("traces a genuine incident from social rumour to operator confirmation", () => {
    const before = signalsForScenario("kj-signal-fault-cluster");
    const after = signalsForScenario("kj-official-confirmation");

    const output = [
      "",
      "=== HOP 1: three independent witnesses, no official source yet ===",
      ...before.signals.map(renderTrace),
      "",
      "=== HOP 2: the operator's KENYATAAN MEDIA arrives at 08:52 ===",
      ...after.signals.map(renderTrace),
      "",
    ].join("\n");
    // eslint-disable-next-line no-console
    console.log(output);

    const social = before.signals[0];
    const confirmed = after.signals[0];

    // INGEST hop = raw evidence volume; VERIFY hop = post-verification value.
    expect(social.provenance.map((h) => [h.hop, h.confidence])).toEqual([
      ["INGEST", 0.45],
      ["VERIFY", 0.45],
    ]);
    expect(confirmed.provenance.map((h) => [h.hop, h.confidence])).toEqual([
      ["INGEST", 0.945],
      ["VERIFY", 0.945],
    ]);

    // The official statement is what makes it a confirmation and sets lead time.
    expect(social.status).toBe("REPORTED");
    expect(social.operatorNotifiedAt).toBeNull();
    expect(confirmed.status).toBe("CONFIRMED");
    expect(confirmed.operatorNotifiedAt).toBe("2024-03-05T08:52:00+08:00");
    expect(confirmed.leadTimeMinutes).toBeGreaterThan(45);
    expect(confirmed.leadTimeMinutes).toBeLessThan(48);

    // The hop sequence is the A3 contract.
    expect(confirmed.provenance.map((h) => h.hop)).toEqual(["INGEST", "VERIFY"]);
  });

  it("shows a sarcastic post losing all its confidence between INGEST and VERIFY", () => {
    const scenario = corpus.scenarioById.get("sarcasm-and-jokes")!;
    const records = scenarioRecords("sarcasm-and-jokes");
    const result = runVerifyAgent({ records, now: scenario.now });

    const output = [
      "",
      "=== SARCASTIC / JOKE POSTS DO NOT BECOME A HIGH-CONFIDENCE SIGNAL ===",
      `scenario=${scenario.id}  records=${records.length}`,
      `signals emitted: ${result.signals.length}`,
      ...result.rejected.flatMap((r) => [
        `  rejected cluster ${r.clusterKey}`,
        `    raw INGEST confidence = ${r.confidence.toFixed(3)}`,
        ...r.hops.map((h) => `    ${h.hop.padEnd(7)} confidence=${h.confidence.toFixed(3)}  ${h.summary}`),
        `    reason: ${r.reason}`,
      ]),
      "",
    ].join("\n");
    // eslint-disable-next-line no-console
    console.log(output);

    // No signal at all — and definitely not a high-confidence one.
    expect(result.signals).toEqual([]);
    expect(result.rejected.length).toBeGreaterThan(0);

    // The raw evidence looked exactly like three witnesses (0.450 MODERATE)...
    const raw = result.rejected.reduce((max, r) => Math.max(max, r.confidence), 0);
    expect(raw).toBeGreaterThanOrEqual(0.45);
    // ...and verification dropped it to zero.
    for (const rejected of result.rejected) {
      const verifyHop = rejected.hops.find((h) => h.hop === "VERIFY")!;
      expect(verifyHop.confidence).toBe(0);
      expect(verifyHop.confidence).toBeLessThan(rejected.confidence);
      expect(rejected.reason).toMatch(/below the reportable threshold/);
    }
  });

  it("shows reposts never becoming a crowd", () => {
    const scenario = corpus.scenarioById.get("repost-storm-one-author")!;
    const records = scenarioRecords("repost-storm-one-author");
    const { candidates } = runIngestAgent({ records, now: scenario.now });
    const { unique, collapsed } = collapseReposts(candidates);
    const summary = distinctSocialAuthors(unique);
    const result = runVerifyAgent({ records, now: scenario.now });

    const output = [
      "",
      "=== SIX REPOSTS OF ONE ORIGINAL ===",
      `records=${records.length}  distinct content=${unique.length}  collapsed=${collapsed.size}`,
      `distinct authors after collapse = ${summary.authors.length} (${summary.authors.join(", ")})`,
      `signals emitted: ${result.signals.length}`,
      ...result.rejected.map(
        (r) => `  rejected ${r.clusterKey}: raw=${r.confidence.toFixed(3)} reason=${r.reason}`,
      ),
      "",
    ].join("\n");
    // eslint-disable-next-line no-console
    console.log(output);

    expect(records.length).toBe(6);
    expect(unique.length).toBe(1);
    expect(summary.authors.length).toBe(1);
    expect(result.signals).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * Silence
 * ------------------------------------------------------------------ */

describe("silence is correct", () => {
  it("produces an empty signal list for the empty corpus scenario", () => {
    const { signals, result } = signalsForScenario("empty-corpus");
    expect(signals).toEqual([]);
    expect(result.rejected).toEqual([]);
  });

  it("never reports below the threshold", () => {
    for (const scenario of corpus.scenarios) {
      const { signals } = signalsForScenario(scenario.id);
      for (const signal of signals) {
        expect(signal.confidence.value, scenario.id).toBeGreaterThanOrEqual(0.3);
      }
    }
  });
});

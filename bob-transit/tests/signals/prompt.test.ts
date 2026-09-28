import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { VERIFY_AGENT_PROMPT, verifyAgentPrompt } from "@/lib/agents/verify/prompt";
import { VERIFY_TOOLS, verifyToolNames } from "@/lib/agents/verify/tools";
import { stationEntityResolverTool } from "@/lib/agents/verify/station-tool";
import { INGEST_TOOLS, ingestToolNames } from "@/lib/agents/ingest/tools";
import { malayDisruptionPhraseParser } from "@/lib/agents/ingest/malay-phrases";

describe("the shipped Verifier prompt", () => {
  it("is a real, readable deliverable", () => {
    expect(VERIFY_AGENT_PROMPT.length).toBeGreaterThan(3000);
    expect(VERIFY_AGENT_PROMPT).toMatch(/false positive sends thousands of commuters/);
    expect(VERIFY_AGENT_PROMPT).toMatch(/distinct authors, never with repost volume/i);
    expect(VERIFY_AGENT_PROMPT).toMatch(/NEVER silently pick one/i);
    expect(VERIFY_AGENT_PROMPT).toMatch(/absence of a vehicle is NOT evidence/i);
    expect(verifyAgentPrompt()).toBe(VERIFY_AGENT_PROMPT);
  });

  it("does not drift from the generated PROMPT.md", () => {
    const file = path.join(process.cwd(), "lib/agents/verify/PROMPT.md");
    const onDisk = readFileSync(file, "utf8");
    expect(onDisk).toContain(VERIFY_AGENT_PROMPT.trimEnd());
  });
});

describe("custom tools (acceptance criterion A7)", () => {
  it("gives the ingest agent at least one genuinely domain-specific tool", () => {
    const names = ingestToolNames();
    expect(names.length).toBeGreaterThanOrEqual(1);
    expect(names).toContain("parse_malay_disruption_phrases");
    expect(names).toContain("assess_social_authenticity");
    for (const tool of INGEST_TOOLS) {
      expect(tool.description.length).toBeGreaterThan(20);
      // Every tool must say why it could not have come from a template.
      expect(tool.provenance.length).toBeGreaterThan(80);
      expect(typeof tool.run).toBe("function");
    }
  });

  it("gives the verify agent at least one genuinely domain-specific tool", () => {
    const names = verifyToolNames();
    expect(names).toContain("resolve_station_entities");
    for (const tool of VERIFY_TOOLS) {
      expect(tool.provenance.length).toBeGreaterThan(80);
      expect(typeof tool.run).toBe("function");
    }
  });

  it("runs the tools and gets real answers", () => {
    const result = stationEntityResolverTool.run({
      text: "Tren berhenti antara KLCC dan Ampang Park.",
    });
    expect(result).toMatchObject({
      resolution: "RESOLVED",
      segmentIds: ["KJ:KJ10->KJ9", "KJ:KJ9->KJ10"],
    });

    const parsed = malayDisruptionPhraseParser.run({ text: "TREN TERKANDAS di Taman Jaya" });
    expect(parsed.issueType).toBe("VEHICLE_BREAKDOWN");
  });
});

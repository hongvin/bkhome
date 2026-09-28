/**
 * A2 — RE-ROUTE UNDER RISK.
 *
 * Scenario (the orchestrator's, derived from the real fixture):
 *   Ampang Park (KJ9) -> Hang Tuah (AG9).
 *   Fastest route (A) rides Kelana Jaya to Masjid Jamek, walks to AG7/SP7, rides
 *   Ampang/Sri Petaling to Hang Tuah.
 *   A wholly different route (B) rides Putrajaya to Tun Razak Exchange, walks to
 *   KG20, rides Kajang to Bukit Bintang, walks to MR6, rides Monorail to MR4.
 *
 * Inject a SEVERE, high-confidence incident on `KJ:KJ10->KJ11` — a segment only
 * route A uses. The router must stop recommending route A and must return a
 * different, materially more reliable itinerary.
 */

import { describe, expect, test } from "vitest";
import { planJourneys } from "@/lib/routing/plan";
import { itinerarySegmentIds } from "@/lib/routing/itinerary";
import type { SegmentRiskLookup } from "@/lib/contracts";
import {
  cachedGraph,
  lineSet,
  lookupFrom,
  makeIncident,
  makeQuery,
  segmentIdsOf,
  summarise,
  testRiskPenalty,
} from "./helpers";

/** KLCC -> Kampung Baru on the Kelana Jaya line: only route A crosses it. */
const INCIDENT_SEGMENT = "KJ:KJ10->KJ11";

function riskyLookup(): SegmentRiskLookup {
  return lookupFrom([makeIncident(INCIDENT_SEGMENT)]);
}

describe("A2: a high-confidence incident re-routes the recommendation", () => {
  const graph = cachedGraph();
  const query = makeQuery("KJ9", "AG9", { maxItineraries: 8 });

  test("baseline: the fastest route does use the incident segment", () => {
    const baseline = planJourneys({ graph, query });
    expect(baseline.length).toBeGreaterThanOrEqual(2);
    expect(segmentIdsOf(baseline[0])).toContain(INCIDENT_SEGMENT);
    // eslint-disable-next-line no-console
    console.log(`A2 baseline (no incident):\n${summarise(baseline)}`);
  });

  test("with the incident: top pick avoids it and is materially more reliable", () => {
    const baseline = planJourneys({ graph, query });
    const baselineTop = baseline[0];
    expect(segmentIdsOf(baselineTop)).toContain(INCIDENT_SEGMENT);

    const after = planJourneys({
      graph,
      query,
      riskLookup: riskyLookup(),
      riskPenalty: testRiskPenalty,
    });

    // eslint-disable-next-line no-console
    console.log(`A2 after incident on ${INCIDENT_SEGMENT}:\n${summarise(after)}`);

    const top = after[0];

    // 1. It is a different itinerary that does not touch the incident.
    expect(top.id).not.toBe(baselineTop.id);
    expect(itinerarySegmentIds(top)).not.toContain(INCIDENT_SEGMENT);
    expect(top.riskySegmentIds).toEqual([]);

    // 2. The old recommendation is still offered, but demoted and priced.
    const riskyRoute = after.find((it) => itinerarySegmentIds(it).includes(INCIDENT_SEGMENT));
    expect(riskyRoute, "the pre-incident route should still be listed").toBeDefined();
    expect(riskyRoute?.expectedDelaySeconds).toBeGreaterThan(0);
    expect(riskyRoute?.riskySegmentIds).toContain(INCIDENT_SEGMENT);
    expect(riskyRoute?.rank).toBeGreaterThan(1);

    // 3. The new top pick has a strictly higher reliability score than the
    //    demoted route, which is the acceptance criterion.
    expect(top.reliabilityScore).toBeGreaterThan(riskyRoute?.reliabilityScore ?? 1);
    expect(top.reliabilityScore).toBeGreaterThanOrEqual(0.9);
    expect(top.reliabilityBadge).toBe("VERY_RELIABLE");
    expect(["AT_RISK", "AVOID"]).toContain(riskyRoute?.reliabilityBadge);

    // 4. Risk widens the P90 window: that is the product thesis.
    expect(riskyRoute?.arrival.p90Seconds ?? 0).toBeGreaterThan(baselineTop.arrival.p90Seconds);
    expect(riskyRoute?.arrival.meanToP90GapSeconds ?? 0).toBeGreaterThan(
      baselineTop.arrival.meanToP90GapSeconds,
    );

    // 5. The re-route is genuinely different, not the same lines re-timed.
    expect(lineSet(top)).not.toBe(lineSet(baselineTop));
  });

  test("rank 1 is the most reliable candidate, not merely the fastest", () => {
    const after = planJourneys({
      graph,
      query,
      riskLookup: riskyLookup(),
      riskPenalty: testRiskPenalty,
    });
    const scores = after.map((it) => it.reliabilityScore);
    expect(after[0].reliabilityScore).toBe(Math.max(...scores));
    // Ranking is monotone non-increasing in reliability.
    for (let i = 1; i < after.length; i += 1) {
      expect(after[i].reliabilityScore).toBeLessThanOrEqual(after[i - 1].reliabilityScore + 1e-9);
      expect(after[i].rank).toBe(i + 1);
    }
  });

  test("the alternative line combination is reachable (PYL + KGL + MR)", () => {
    const after = planJourneys({
      graph,
      query,
      riskLookup: riskyLookup(),
      riskPenalty: testRiskPenalty,
      // maxItineraries comes from the query
    });
    const combos = after.map(lineSet);
    expect(combos).toContain("PYL+AG");
    // The baseline run surfaces the three-line interchange route; assert it
    // exists for this origin/destination pair at all.
    const baseline = planJourneys({ graph, query: makeQuery("KJ9", "AG9", { maxItineraries: 8 }) });
    const baselineCombos = baseline.map(lineSet);
    expect(baselineCombos).toContain("KGL+MR+PYL");
    expect(
      baseline.some((it) => itinerarySegmentIds(it).length >= 4 && it.transferCount >= 2),
    ).toBe(true);
  });

  test("reliability-first ranking still re-routes when only riskLookup is supplied", () => {
    // S4's penalty function may not exist yet; the router must not be blocked.
    const after = planJourneys({ graph, query, riskLookup: riskyLookup() });
    expect(itinerarySegmentIds(after[0])).not.toContain(INCIDENT_SEGMENT);
    const riskyRoute = after.find((it) => itinerarySegmentIds(it).includes(INCIDENT_SEGMENT));
    expect(riskyRoute).toBeDefined();
    expect(after[0].reliabilityScore).toBeGreaterThan(riskyRoute?.reliabilityScore ?? 1);
  });

  test("an incident elsewhere does not disturb the top pick", () => {
    const unaffected = planJourneys({
      graph,
      query,
      riskLookup: lookupFrom([makeIncident("BRT:BRT1->BRT2")]),
      riskPenalty: testRiskPenalty,
    });
    const baseline = planJourneys({ graph, query });
    expect(segmentIdsOf(unaffected[0])).toContain(INCIDENT_SEGMENT);
    expect(lineSet(unaffected[0])).toBe(lineSet(baseline[0]));
    expect(unaffected[0].reliabilityScore).toBeCloseTo(baseline[0].reliabilityScore, 6);
  });

  test("re-running the same risky query is deterministic", () => {
    const first = planJourneys({
      graph,
      query,
      riskLookup: riskyLookup(),
      riskPenalty: testRiskPenalty,
    });
    const second = planJourneys({
      graph,
      query,
      riskLookup: riskyLookup(),
      riskPenalty: testRiskPenalty,
    });
    expect(second).toEqual(first);
  });

  test("every itinerary carries a real rank explanation", () => {
    const after = planJourneys({
      graph,
      query,
      riskLookup: riskyLookup(),
      riskPenalty: testRiskPenalty,
    });
    for (const itinerary of after) {
      expect(itinerary.whyThisRank.length).toBeGreaterThan(40);
      expect(itinerary.whyThisRank).toMatch(/Ranked \d+(st|nd|rd|th) of \d+/);
      expect(itinerary.whyThisRank.trim().endsWith(".")).toBe(true);
      expect(itinerary.whyThisRank).not.toMatch(/TODO|placeholder|brevity/i);
    }
    expect(after[0].whyThisRank).not.toContain("flagged");
  });
});

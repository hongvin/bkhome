import { it } from "vitest";
import { buildRouteQuery, dataSource } from "@/lib/mock";

it("diag", () => {
  const adv = dataSource.planRoute(buildRouteQuery("KJ15", "KG35"), "cache");
  for (const i of adv.itineraries) {
    console.log(
      `rank=${i.rank} id=${i.id} score=${i.reliabilityScore} badge=${i.reliabilityBadge} ` +
      `mean=${(i.totalDurationSeconds/60).toFixed(1)}min p90=${(i.arrival.p90Seconds/3600).toFixed(2)}h gap=${i.arrival.meanToP90GapSeconds}s ` +
      `xfer=${i.transferCount} maxProb=${i.maxDegradationProbability} delay=${i.expectedDelaySeconds}s risky=${JSON.stringify(i.riskySegmentIds)}`
    );
    console.log("   ", i.legs.map(l => `${l.kind}/${l.lineId ?? "-"}/${l.fromStationId}->${l.toStationId}/${l.arrivalTime-l.departureTime}s`).join(" | "));
  }
  console.log("rec:", adv.recommendedItineraryId);
  console.log("top why:", adv.itineraries[0]?.whyThisRank);
});

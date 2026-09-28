/**
 * A5 — OFFLINE ROUTING.
 *
 * The airplane-mode path is: fetch `public/graph/transit-graph.json` once, store
 * it, then parse it back and route with no server. These tests prove the router
 * works from that serialized artifact alone, with the network hard-disabled, and
 * that nothing in `lib/routing` can even reach for the network.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { parseTransitGraph } from "@/lib/gtfs/graph-io";
import { planJourneys } from "@/lib/routing/plan";
import { itinerarySignature } from "@/lib/routing/itinerary";
import { GRAPH_PATH, REPO_ROOT, makeQuery, readGraphJson, summarise } from "./helpers";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function withNetworkDisabled<T>(fn: () => T): T {
  const stub = (() => {
    throw new Error("NETWORK ACCESS ATTEMPTED during offline routing");
  }) as unknown as typeof fetch;
  globalThis.fetch = stub;
  try {
    return fn();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

describe("A5: offline routing from the serialized cached graph", () => {
  test("the cached artifact exists on disk and is non-trivial", () => {
    expect(statSync(GRAPH_PATH).size).toBeGreaterThan(1_000_000);
    const json = readGraphJson();
    expect(json.length).toBe(statSync(GRAPH_PATH).size);
  });

  test("KLCC -> KL Sentral plans from the on-disk JSON with fetch disabled", () => {
    const json = readGraphJson();
    const graph = parseTransitGraph(json);

    const itineraries = withNetworkDisabled(() =>
      planJourneys({ graph, query: makeQuery("KJ10", "KJ15") }),
    );

    expect(itineraries.length).toBeGreaterThanOrEqual(2);
    expect(itineraries[0].rank).toBe(1);
    expect(itineraries[0].legs.some((leg) => leg.kind === "RIDE")).toBe(true);
    // eslint-disable-next-line no-console
    console.log(`A5 KLCC -> KL Sentral from cached JSON:\n${summarise(itineraries)}`);
  });

  test("a cross-line journey works offline (transfer topology is derived, not fetched)", () => {
    const graph = parseTransitGraph(readGraphJson());
    const itineraries = withNetworkDisabled(() =>
      planJourneys({ graph, query: makeQuery("KJ9", "AG9", { maxItineraries: 8 }) }),
    );

    expect(itineraries.length).toBeGreaterThanOrEqual(2);
    const signatures = new Set(itineraries.map(itinerarySignature));
    expect(signatures.size).toBe(itineraries.length);
    // Ampang Park and Hang Tuah share no line, so this can only resolve through
    // an interchange footpath.
    for (const itinerary of itineraries) {
      expect(itinerary.transferCount).toBeGreaterThanOrEqual(1);
    }
    // eslint-disable-next-line no-console
    console.log(`A5 Ampang Park -> Hang Tuah from cached JSON:\n${summarise(itineraries)}`);
  });

  test("routing from the serialized JSON is deterministic", () => {
    const graph = parseTransitGraph(readGraphJson());
    const first = withNetworkDisabled(() => planJourneys({ graph, query: makeQuery("KJ10", "KJ15") }));
    const second = withNetworkDisabled(() => planJourneys({ graph, query: makeQuery("KJ10", "KJ15") }));
    expect(second).toEqual(first);
  });

  test("a JSON round-trip through a plain string changes nothing", () => {
    const graph = parseTransitGraph(readGraphJson());
    const viaString = parseTransitGraph(JSON.stringify(JSON.parse(readGraphJson())));
    const a = planJourneys({ graph, query: makeQuery("KJ10", "KJ15") });
    const b = planJourneys({ graph: viaString, query: makeQuery("KJ10", "KJ15") });
    expect(b).toEqual(a);
  });

  test("no file under lib/routing can reach the network", () => {
    const dir = join(REPO_ROOT, "lib/routing");
    const forbidden: Array<[string, RegExp]> = [
      ["fetch(", /\bfetch\s*\(/],
      ["XMLHttpRequest", /XMLHttpRequest/],
      ["node:http/https/net/dns", /from\s+["']node:(http|https|net|dns)["']/],
      ["axios", /\baxios\b/],
      ["require(", /\brequire\s*\(/],
    ];
    const offenders: string[] = [];
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith(".ts")) continue;
      const source = readFileSync(join(dir, entry), "utf8");
      for (const [label, pattern] of forbidden) {
        if (pattern.test(source)) offenders.push(`${entry}: ${label}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

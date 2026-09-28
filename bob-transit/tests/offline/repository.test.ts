import { afterEach, describe, expect, it } from "vitest";
import {
  SCHEMA_VERSION,
  createRepository,
  effectiveDatabaseUrl,
  resolveRepositoryDriver,
  type TransitRepository,
} from "@/lib/db";
import { makeGraph, makeOverlay, makeSegmentRisk, makeSignal, SEGMENT_KJ } from "./fixtures";

/**
 * Every test in this file runs against PGlite — real Postgres compiled to WASM,
 * embedded in the process. No server, no credential, no network.
 */

const open: TransitRepository[] = [];

async function repo(): Promise<TransitRepository> {
  const repository = await createRepository({ databaseUrl: null });
  open.push(repository);
  return repository;
}

afterEach(async () => {
  while (open.length > 0) {
    await open.pop()?.close();
  }
});

function stubFetchToFail() {
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = ((input: RequestInfo | URL) => {
    calls.push(String(input));
    throw new Error("the repository must never touch the network");
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

describe("driver selection", () => {
  it("defaults to PGlite when no credential is configured", () => {
    const previous = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      expect(effectiveDatabaseUrl({})).toBeNull();
      expect(resolveRepositoryDriver({})).toBe("pglite");
    } finally {
      if (previous !== undefined) process.env.DATABASE_URL = previous;
    }
  });

  it("selects pg when DATABASE_URL is set", () => {
    const previous = process.env.DATABASE_URL;
    process.env.DATABASE_URL = "postgres://user:pass@example.invalid:5432/transit";
    try {
      expect(resolveRepositoryDriver({})).toBe("pg");
    } finally {
      if (previous === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previous;
    }
  });

  it("lets a caller force the embedded driver even when DATABASE_URL is set", () => {
    const previous = process.env.DATABASE_URL;
    process.env.DATABASE_URL = "postgres://user:pass@example.invalid:5432/transit";
    try {
      expect(resolveRepositoryDriver({ databaseUrl: null })).toBe("pglite");
      expect(resolveRepositoryDriver({ databaseUrl: "" })).toBe("pglite");
    } finally {
      if (previous === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previous;
    }
  });
});

describe("PGlite repository", () => {
  it("migrates a real Postgres schema with no credential and no network", async () => {
    const stub = stubFetchToFail();
    try {
      const repository = await repo();
      expect(repository.driver).toBe("pglite");
      expect(await repository.schemaVersion()).toBe(SCHEMA_VERSION);

      const stats = await repository.stats();
      expect(stats.schemaVersion).toBe(SCHEMA_VERSION);
      expect(stats.signals).toBe(0);
      expect(stub.calls).toEqual([]);
    } finally {
      stub.restore();
    }
  });

  it("upserts a signal and reads it back byte-faithfully", async () => {
    const repository = await repo();
    const signal = makeSignal("sig-1", { confidence: 0.72 });

    await repository.upsertSignal(signal);
    const loaded = await repository.getSignal("sig-1");

    expect(loaded).toEqual(signal);
    expect(loaded?.sources).toHaveLength(2);
    expect(loaded?.provenance.map((hop) => hop.hop)).toEqual(["INGEST", "VERIFY"]);

    // Upsert (not insert): the second write replaces the first.
    const updated = makeSignal("sig-1", { confidence: 0.95, status: "CONFIRMED" });
    await repository.upsertSignal(updated);
    expect(await repository.getSignal("sig-1")).toEqual(updated);

    const stats = await repository.stats();
    expect(stats.signals).toBe(1);
    expect(stats.sources).toBe(2);
  });

  it("returns null for a signal that does not exist", async () => {
    const repository = await repo();
    expect(await repository.getSignal("nope")).toBeNull();
  });

  it("lists only active signals for the given instant", async () => {
    const repository = await repo();
    await repository.upsertSignal(
      makeSignal("sig-active", {
        windowEndsAt: "2025-01-02T02:00:00.000Z",
        updatedAt: "2025-01-02T00:35:00.000Z",
      }),
    );
    await repository.upsertSignal(
      makeSignal("sig-expired", { windowEndsAt: "2025-01-02T00:10:00.000Z" }),
    );
    await repository.upsertSignal(makeSignal("sig-cleared", { status: "CLEARED" }));
    await repository.upsertSignal(makeSignal("sig-open", { windowEndsAt: null }));

    const active = await repository.listActiveSignals("2025-01-02T00:42:00.000Z");
    expect(active.map((signal) => signal.id).sort()).toEqual(["sig-active", "sig-open"]);
  });

  it("answers the reconciliation query: signals changed since a cursor", async () => {
    const repository = await repo();
    await repository.upsertSignal(
      makeSignal("sig-old", { updatedAt: "2025-01-02T00:20:00.000Z" }),
    );
    await repository.upsertSignal(
      makeSignal("sig-middle", { updatedAt: "2025-01-02T00:35:00.000Z" }),
    );
    await repository.upsertSignal(
      makeSignal("sig-new", { updatedAt: "2025-01-02T00:41:00.000Z" }),
    );

    const changed = await repository.listSignalsChangedSince("2025-01-02T00:30:00.000Z");
    expect(changed.map((signal) => signal.id)).toEqual(["sig-middle", "sig-new"]);

    const none = await repository.listSignalsChangedSince("2025-01-02T00:42:00.000Z");
    expect(none).toEqual([]);

    // A cleared signal must appear in the delta so the client can reconcile it.
    await repository.upsertSignal(
      makeSignal("sig-middle", { status: "CLEARED", updatedAt: "2025-01-02T00:43:00.000Z" }),
    );
    const afterClear = await repository.listSignalsChangedSince("2025-01-02T00:42:00.000Z");
    expect(afterClear.map((signal) => signal.id)).toEqual(["sig-middle"]);
    expect(afterClear[0].status).toBe("CLEARED");
  });

  it("finds signals by segment through the join table", async () => {
    const repository = await repo();
    await repository.upsertSignal(makeSignal("sig-1", { segmentIds: [SEGMENT_KJ] }));
    await repository.upsertSignal(makeSignal("sig-2", { segmentIds: [] }));

    const bySegment = await repository.listSignalsBySegment(SEGMENT_KJ, "2025-01-02T00:42:00.000Z");
    expect(bySegment.map((signal) => signal.id)).toEqual(["sig-1"]);
  });

  it("records risk snapshots from an overlay and reads them back", async () => {
    const repository = await repo();
    const overlay = makeOverlay();

    expect(await repository.recordRiskSnapshots(overlay)).toBe(overlay.segments.length);

    const snapshots = await repository.listRiskSnapshots(SEGMENT_KJ);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].segmentId).toBe(SEGMENT_KJ);
    expect(snapshots[0].degradationProbability).toBeCloseTo(0.6, 10);
    expect(snapshots[0].severity).toBe("MAJOR");
    expect(snapshots[0].computedAt).toBe("2025-01-02T00:35:00.000Z");
    expect(snapshots[0].stale).toBe(false);

    // A single snapshot, with overlay metadata attached.
    await repository.recordRiskSnapshot({
      segment: makeSegmentRisk(SEGMENT_KJ, { confidence: 0.4, stale: true }),
      overlay: {
        generatedAt: overlay.generatedAt,
        asOf: overlay.asOf,
        stalenessMinutes: 7,
      },
    });
    const both = await repository.listRiskSnapshots(SEGMENT_KJ, 10);
    expect(both).toHaveLength(2);
    expect(both.some((snapshot) => snapshot.stale)).toBe(true);
    expect((await repository.stats()).riskSnapshots).toBe(3);
  });

  it("caches graph segments and vehicle positions", async () => {
    const repository = await repo();
    const graph = makeGraph();

    expect(await repository.upsertSegments(graph.segments)).toBe(graph.segments.length);
    await repository.recordVehiclePosition({
      vehicleId: "KJ-T01",
      lineId: "KJ",
      tripId: "KJ-1",
      segmentId: SEGMENT_KJ,
      lat: 3.1579,
      lon: 101.7116,
      observedAt: "2025-01-02T00:42:00.000Z",
    });

    const stats = await repository.stats();
    expect(stats.segments).toBe(graph.segments.length);
    expect(stats.vehiclePositions).toBe(1);
  });

  it("rolls the whole signal write back when the transaction fails", async () => {
    const repository = await repo();
    const broken = makeSignal("sig-broken");
    // A source with an empty id is rejected by Postgres, mid-transaction.
    broken.sources = [{ ...broken.sources[0], id: null as unknown as string }];

    await expect(repository.upsertSignal(broken)).rejects.toBeTruthy();
    expect(await repository.getSignal("sig-broken")).toBeNull();
    expect((await repository.stats()).signals).toBe(0);
  });

  it("does not need the network for any repository call", async () => {
    const stub = stubFetchToFail();
    try {
      const repository = await repo();
      await repository.upsertSignal(makeSignal("sig-1"));
      await repository.recordRiskSnapshots(makeOverlay());
      await repository.listActiveSignals("2025-01-02T00:42:00.000Z");
      await repository.listSignalsChangedSince("2025-01-01T00:00:00.000Z");
      await repository.stats();
      expect(stub.calls).toEqual([]);
    } finally {
      stub.restore();
    }
  });

  it("is safe to migrate twice", async () => {
    const repository = await repo();
    await repository.migrate();
    await repository.migrate();
    expect(await repository.schemaVersion()).toBe(SCHEMA_VERSION);
  });
});

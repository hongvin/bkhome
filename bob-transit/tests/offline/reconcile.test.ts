import { describe, expect, it } from "vitest";
import { applyServerReconcile, reconcile, toReconcileRequest } from "@/lib/offline/reconcile";
import {
  createHttpReconcileFetcher,
  createHttpServerStateFetcher,
  EPOCH_CURSOR,
  reconcileOnReconnect,
  type ServerSignalState,
} from "@/lib/offline/reconnect";
import { SignalStateCache, buildSignalState } from "@/lib/offline/signal-cache";
import { MemoryKeyValueStore } from "@/lib/offline/store";
import { makeOverlay, makeSignal } from "./fixtures";

const SINCE = "2025-01-02T00:30:00.000Z"; // 08:30 KL
const SERVER_TIME = "2025-01-02T00:42:00.000Z";
const NOW = new Date(SERVER_TIME);
const OVERLAY = makeOverlay();

function run(
  cachedSignals: Parameters<typeof reconcile>[0]["cachedSignals"],
  serverSignals: Parameters<typeof reconcile>[0]["serverSignals"],
  since = SINCE,
) {
  return reconcile({
    since,
    cachedSignals,
    serverSignals,
    overlay: OVERLAY,
    serverTime: SERVER_TIME,
  });
}

describe("reconcile: classification", () => {
  it("builds the frozen ReconcileRequest body", () => {
    expect(toReconcileRequest(SINCE)).toEqual({ since: SINCE });
  });

  it("classifies new, cleared, changed and unchanged signals", () => {
    const cachedA = makeSignal("sig-a", { updatedAt: "2025-01-02T00:31:00.000Z" });
    const cachedB = makeSignal("sig-b", { updatedAt: "2025-01-02T00:31:00.000Z" });
    const cachedC = makeSignal("sig-c", { updatedAt: "2025-01-02T00:31:00.000Z" });

    const serverA = makeSignal("sig-a", { updatedAt: "2025-01-02T00:31:00.000Z" }); // unchanged
    const serverC = makeSignal("sig-c", {
      updatedAt: "2025-01-02T00:40:00.000Z",
      confidence: 0.91,
    }); // changed
    const serverD = makeSignal("sig-d", { updatedAt: "2025-01-02T00:41:00.000Z" }); // new
    // sig-b is absent from the server => cleared.

    const result = run([cachedA, cachedB, cachedC], [serverA, serverC, serverD]);

    expect(result.response.newSignalIds).toEqual(["sig-d"]);
    expect(result.response.clearedSignalIds).toEqual(["sig-b"]);
    expect(result.response.changedSignals.map((s) => s.id)).toEqual(["sig-c"]);
    expect(result.unchangedSignalIds).toEqual(["sig-a"]);
    expect(result.response.overlay).toBe(OVERLAY);
    expect(result.response.serverTime).toBe(SERVER_TIME);
    expect(result.cursor).toBe(SERVER_TIME);
  });

  it("classifies a confidence rise and a confidence fall distinctly", () => {
    const cachedUp = makeSignal("sig-up", { confidence: 0.5 });
    const cachedDown = makeSignal("sig-down", { confidence: 0.9 });
    const serverUp = makeSignal("sig-up", { confidence: 0.8, updatedAt: "2025-01-02T00:41:00.000Z" });
    const serverDown = makeSignal("sig-down", { confidence: 0.3, updatedAt: "2025-01-02T00:41:00.000Z" });

    const result = run([cachedUp, cachedDown], [serverUp, serverDown]);

    const kinds = new Map(result.changes.map((change) => [change.signalId, change.kind]));
    expect(kinds.get("sig-up")).toBe("CONFIDENCE_UP");
    expect(kinds.get("sig-down")).toBe("CONFIDENCE_DOWN");
    expect(result.response.changedSignals.map((s) => s.id).sort()).toEqual(["sig-down", "sig-up"]);
  });

  it("treats a server-side CLEARED status as cleared even though the id is still present", () => {
    const cached = makeSignal("sig-x");
    const server = makeSignal("sig-x", { status: "CLEARED", updatedAt: "2025-01-02T00:41:00.000Z" });
    const result = run([cached], [server]);
    expect(result.response.clearedSignalIds).toEqual(["sig-x"]);
    expect(result.response.changedSignals).toEqual([]);
  });

  it("does not re-report a signal that was already cleared on the device", () => {
    const cached = makeSignal("sig-old", { status: "CLEARED" });
    const result = run([cached], []);
    expect(result.response.clearedSignalIds).toEqual([]);
    expect(result.unchangedSignalIds).toEqual(["sig-old"]);
    expect(result.summary).toBe("No changes since 08:30.");
  });

  it("ignores a terminal signal the device has never seen", () => {
    const result = run([], [makeSignal("sig-gone", { status: "REJECTED" })]);
    expect(result.response.newSignalIds).toEqual([]);
    expect(result.unchangedSignalIds).toEqual(["sig-gone"]);
  });

  it("is deterministic: output arrays are sorted by signal id", () => {
    const cached = [makeSignal("sig-z"), makeSignal("sig-m"), makeSignal("sig-a")];
    const result = run(cached, []);
    expect(result.response.clearedSignalIds).toEqual(["sig-a", "sig-m", "sig-z"]);
    expect(result.changes.map((c) => c.signalId)).toEqual(["sig-a", "sig-m", "sig-z"]);
  });

  it("summarises what changed in one sentence", () => {
    const result = run(
      [makeSignal("sig-b")],
      [makeSignal("sig-a", { updatedAt: "2025-01-02T00:40:00.000Z" })],
    );
    expect(result.summary).toBe("1 new, 1 cleared since 08:30.");
    expect(result.changes.find((c) => c.signalId === "sig-a")?.summary).toContain("New");
    expect(result.changes.find((c) => c.signalId === "sig-b")?.summary).toContain("cleared");
  });

  it("produces a nextSignals set with cleared signals dropped and new ones merged", () => {
    const cachedA = makeSignal("sig-a", { updatedAt: "2025-01-02T00:31:00.000Z" });
    const cachedB = makeSignal("sig-b", { updatedAt: "2025-01-02T00:31:00.000Z" });
    const serverA = makeSignal("sig-a", { updatedAt: "2025-01-02T00:41:00.000Z", confidence: 0.95 });
    const serverD = makeSignal("sig-d", { updatedAt: "2025-01-02T00:42:00.000Z" });

    const result = run([cachedA, cachedB], [serverA, serverD]);
    expect(result.nextSignals.map((s) => s.id)).toEqual(["sig-d", "sig-a"]);
    expect(result.nextSignals.find((s) => s.id === "sig-a")?.confidence.value).toBe(0.95);
  });
});

describe("reconcileOnReconnect", () => {
  const serverState: ServerSignalState = {
    signals: [makeSignal("sig-1", { confidence: 0.9, updatedAt: "2025-01-02T00:41:00.000Z" })],
    overlay: OVERLAY,
    asOf: "2025-01-02T00:42:00.000Z",
    serverTime: SERVER_TIME,
  };

  it("does nothing on the network when offline, and says so honestly", async () => {
    const store = new MemoryKeyValueStore();
    await new SignalStateCache(store).save(
      buildSignalState({
        signals: [makeSignal("sig-1", { confidence: 0.4 })],
        overlay: OVERLAY,
        asOf: "2025-01-02T00:35:00.000Z",
        serverTime: "2025-01-02T00:35:10.000Z",
        cachedAt: "2025-01-02T00:35:11.000Z",
      }),
    );

    let calls = 0;
    const outcome = await reconcileOnReconnect({
      store,
      fetchServerState: async () => {
        calls += 1;
        return serverState;
      },
      isOnline: () => false,
      now: () => NOW,
    });

    expect(calls).toBe(0);
    expect(outcome.skipped).toBe(true);
    expect(outcome.result).toBeNull();
    expect(outcome.reason).toContain("Offline");
    expect(outcome.view?.label).toBe("as of 08:35, 7 min ago");
  });

  it("reconciles, persists the new state and advances the cursor when online", async () => {
    const store = new MemoryKeyValueStore();
    const cache = new SignalStateCache(store);
    await cache.save(
      buildSignalState({
        signals: [makeSignal("sig-1", { confidence: 0.4 })],
        overlay: OVERLAY,
        asOf: "2025-01-02T00:35:00.000Z",
        serverTime: "2025-01-02T00:35:10.000Z",
        cachedAt: "2025-01-02T00:35:11.000Z",
      }),
    );

    const seenCursors: string[] = [];
    const outcome = await reconcileOnReconnect({
      store,
      fetchServerState: async (since) => {
        seenCursors.push(since);
        return serverState;
      },
      isOnline: () => true,
      now: () => NOW,
    });

    expect(seenCursors).toEqual(["2025-01-02T00:35:10.000Z"]);
    expect(outcome.skipped).toBe(false);
    expect(outcome.result?.response.changedSignals.map((s) => s.id)).toEqual(["sig-1"]);
    expect(await cache.cursor()).toBe(SERVER_TIME);
    expect((await cache.load())?.signals[0].confidence.value).toBe(0.9);
    expect(outcome.view?.label).toBe("as of 08:42, 0 min ago");
  });

  it("asks for everything on a first-ever sync", async () => {
    const store = new MemoryKeyValueStore();
    const seenCursors: string[] = [];
    await reconcileOnReconnect({
      store,
      fetchServerState: async (since) => {
        seenCursors.push(since);
        return serverState;
      },
      isOnline: () => true,
      now: () => NOW,
    });
    expect(seenCursors).toEqual([EPOCH_CURSOR]);
  });
});

describe("applyServerReconcile", () => {
  it("merges a server-computed diff into the cached set", () => {
    const cachedA = makeSignal("sig-a", { confidence: 0.4, updatedAt: "2025-01-02T00:31:00.000Z" });
    const cachedB = makeSignal("sig-b", { updatedAt: "2025-01-02T00:31:00.000Z" });
    const serverA = makeSignal("sig-a", { confidence: 0.9, updatedAt: "2025-01-02T00:41:00.000Z" });
    const serverD = makeSignal("sig-d", { updatedAt: "2025-01-02T00:42:00.000Z" });

    const applied = applyServerReconcile(
      [cachedA, cachedB],
      {
        changedSignals: [serverA, serverD],
        clearedSignalIds: ["sig-b"],
        newSignalIds: ["sig-d"],
        overlay: OVERLAY,
        serverTime: SERVER_TIME,
      },
      { since: SINCE },
    );

    expect(applied.nextSignals.map((signal) => signal.id)).toEqual(["sig-d", "sig-a"]);
    expect(applied.nextSignals.find((signal) => signal.id === "sig-a")?.confidence.value).toBe(0.9);
    const kinds = new Map(applied.changes.map((change) => [change.signalId, change.kind]));
    expect(kinds.get("sig-a")).toBe("CONFIDENCE_UP");
    expect(kinds.get("sig-b")).toBe("CLEARED");
    expect(kinds.get("sig-d")).toBe("NEW");
    expect(applied.summary).toBe("1 new, 1 cleared, 1 updated since 08:30.");
  });

  it("drops a signal the server marked terminal", () => {
    const cached = makeSignal("sig-a");
    const applied = applyServerReconcile([cached], {
      changedSignals: [makeSignal("sig-a", { status: "CLEARED" })],
      clearedSignalIds: [],
      newSignalIds: [],
      overlay: OVERLAY,
      serverTime: SERVER_TIME,
    });
    expect(applied.nextSignals).toEqual([]);
    expect(applied.changes[0].kind).toBe("UPDATED");
  });

  it("says so when the server reports nothing new", () => {
    const applied = applyServerReconcile([makeSignal("sig-a")], {
      changedSignals: [],
      clearedSignalIds: [],
      newSignalIds: [],
      overlay: OVERLAY,
      serverTime: SERVER_TIME,
    });
    expect(applied.summary).toBe("No changes from the server.");
    expect(applied.nextSignals.map((signal) => signal.id)).toEqual(["sig-a"]);
  });
});

describe("createHttpReconcileFetcher", () => {
  it("unwraps ApiOk<ReconcileResponse> from /api/reconcile", async () => {
    const calls: string[] = [];
    const body = {
      changedSignals: [makeSignal("sig-1")],
      clearedSignalIds: [],
      newSignalIds: ["sig-1"],
      overlay: OVERLAY,
      serverTime: SERVER_TIME,
    };
    const fetchImpl = (async (url: string) => {
      calls.push(url);
      return new Response(
        JSON.stringify({
          ok: true,
          data: body,
          meta: {
            generatedAt: SERVER_TIME,
            cached: false,
            asOf: "2025-01-02T00:42:00.000Z",
            stalenessMinutes: 0,
            contractsVersion: "1.0.0",
          },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const fetcher = createHttpReconcileFetcher({ fetchImpl });
    const response = await fetcher(SINCE);
    expect(response.newSignalIds).toEqual(["sig-1"]);
    expect(calls).toEqual([`/api/reconcile?since=${encodeURIComponent(SINCE)}`]);
  });

  it("throws on a non-OK status", async () => {
    const fetchImpl = (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch;
    await expect(createHttpReconcileFetcher({ fetchImpl })(SINCE)).rejects.toThrow(/500/);
  });
});

describe("createHttpServerStateFetcher", () => {
  it("unwraps the frozen ApiResponse envelope", async () => {
    const signal = makeSignal("sig-1");
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(url);
      if (url.startsWith("/api/signals")) {
        return new Response(
          JSON.stringify({
            ok: true,
            data: { signals: [signal] },
            meta: {
              generatedAt: SERVER_TIME,
              cached: false,
              asOf: "2025-01-02T00:42:00.000Z",
              stalenessMinutes: 0,
              contractsVersion: "1.0.0",
            },
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          ok: true,
          data: { overlay: OVERLAY },
          meta: {
            generatedAt: SERVER_TIME,
            cached: false,
            asOf: "2025-01-02T00:42:00.000Z",
            stalenessMinutes: 0,
            contractsVersion: "1.0.0",
          },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const fetcher = createHttpServerStateFetcher({ fetchImpl });
    const state = await fetcher(SINCE);

    expect(state.signals).toEqual([signal]);
    expect(state.overlay).toEqual(OVERLAY);
    expect(state.asOf).toBe("2025-01-02T00:42:00.000Z");
    expect(state.serverTime).toBe(SERVER_TIME);
    expect(calls[0]).toBe(`/api/signals?since=${encodeURIComponent(SINCE)}`);
    expect(calls[1]).toBe("/api/risk");
  });

  it("throws on an error envelope rather than pretending it succeeded", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ ok: false, error: { code: "INTERNAL" } }), {
        status: 200,
      })) as unknown as typeof fetch;
    const fetcher = createHttpServerStateFetcher({ fetchImpl });
    await expect(fetcher(SINCE)).rejects.toThrow(/ApiOk/);
  });
});

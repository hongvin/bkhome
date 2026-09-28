import { describe, expect, it } from "vitest";
import { CONTRACTS_VERSION } from "@/lib/contracts";
import {
  OFFLINE_CACHE_FACTOR_NAME,
  OFFLINE_CONFIDENCE_FACTOR,
  degradeConfidenceForOfflineCache,
  degradeOverlayForOfflineCache,
  degradeSignalForOfflineCache,
  offlineReason,
} from "@/lib/offline/degrade";
import {
  SIGNAL_STATE_CACHE_KEY,
  SignalStateCache,
  buildSignalState,
  describeSignalState,
  loadSignalStateView,
} from "@/lib/offline/signal-cache";
import { MemoryKeyValueStore } from "@/lib/offline/store";
import { makeOverlay, makeSegmentRisk, makeSignal, SEGMENT_KJ } from "./fixtures";

const NOW = new Date("2025-01-02T00:42:00.000Z"); // 08:42 KL

describe("SignalStateCache", () => {
  it("persists the last-known disruption state and the reconcile cursor", async () => {
    const store = new MemoryKeyValueStore();
    const cache = new SignalStateCache(store);
    const signals = [makeSignal("sig-1"), makeSignal("sig-2")];
    const overlay = makeOverlay();

    expect(await cache.load()).toBeNull();
    expect(await cache.cursor()).toBeNull();

    await cache.save(
      buildSignalState({
        signals,
        overlay,
        asOf: "2025-01-02T00:35:00.000Z",
        serverTime: "2025-01-02T00:35:10.000Z",
        cachedAt: "2025-01-02T00:35:11.000Z",
      }),
    );

    const loaded = await cache.load();
    expect(loaded?.signals).toEqual(signals);
    expect(loaded?.overlay).toEqual(overlay);
    expect(loaded?.asOf).toBe("2025-01-02T00:35:00.000Z");
    expect(loaded?.cacheKey).toBe(SIGNAL_STATE_CACHE_KEY);
    expect(await cache.cursor()).toBe("2025-01-02T00:35:10.000Z");
  });

  it("treats a contracts mismatch as no cache", async () => {
    const store = new MemoryKeyValueStore();
    await store.set(SIGNAL_STATE_CACHE_KEY, {
      cacheKey: SIGNAL_STATE_CACHE_KEY,
      contractsVersion: "0.0.1",
      cachedAt: "2025-01-02T00:35:11.000Z",
      asOf: "2025-01-02T00:35:00.000Z",
      lastSyncAt: "2025-01-02T00:35:10.000Z",
      signals: [],
      overlay: null,
    });
    const cache = new SignalStateCache(store);
    expect(await cache.load()).toBeNull();
    expect(await cache.loadRaw()).not.toBeNull();
  });

  it("describes cached state with an honest label, staleness and reason", async () => {
    const store = new MemoryKeyValueStore();
    const cache = new SignalStateCache(store);
    await cache.save(
      buildSignalState({
        signals: [makeSignal("sig-1")],
        overlay: makeOverlay(),
        asOf: "2025-01-02T00:35:00.000Z",
        serverTime: "2025-01-02T00:35:10.000Z",
        cachedAt: "2025-01-02T00:35:11.000Z",
      }),
    );

    const view = await loadSignalStateView(store, { now: NOW, offline: true });
    expect(view).not.toBeNull();
    expect(view?.label).toBe("as of 08:35, 7 min ago");
    expect(view?.staleness.minutes).toBe(7);
    expect(view?.isStale).toBe(true);
    expect(view?.confidenceDegraded).toBe(true);
    expect(view?.reason).toContain("Offline");
    expect(view?.reason).toContain("as of 08:35, 7 min ago");
  });

  it("marks fresh online data as not stale", async () => {
    const state = buildSignalState({
      signals: [makeSignal("sig-1")],
      overlay: makeOverlay(),
      asOf: "2025-01-02T00:41:00.000Z",
      serverTime: "2025-01-02T00:41:05.000Z",
      cachedAt: "2025-01-02T00:41:06.000Z",
    });
    const view = describeSignalState(state, { now: NOW, offline: false });
    expect(view.label).toBe("as of 08:41, 1 min ago");
    expect(view.isStale).toBe(false);
    expect(view.confidenceDegraded).toBe(false);
  });

  it("returns null when the device has never synced", async () => {
    expect(await loadSignalStateView(new MemoryKeyValueStore(), { now: NOW, offline: true })).toBeNull();
  });

  it("stamps the running contracts version", () => {
    const state = buildSignalState({
      signals: [],
      asOf: "2025-01-02T00:35:00.000Z",
      serverTime: "2025-01-02T00:35:10.000Z",
      cachedAt: "2025-01-02T00:35:11.000Z",
    });
    expect(state.contractsVersion).toBe(CONTRACTS_VERSION);
  });
});

describe("offline confidence degradation", () => {
  it("reduces the confidence value, recomputes the band and flags the cache", () => {
    const signal = makeSignal("sig-1", { confidence: 0.72 });
    const degraded = degradeSignalForOfflineCache(signal, { now: NOW });

    expect(degraded.confidence.degradedByOfflineCache).toBe(true);
    expect(degraded.confidence.value).toBeCloseTo(0.72 * OFFLINE_CONFIDENCE_FACTOR, 10);
    expect(degraded.confidence.band).toBe("MODERATE");
    expect(degraded.confidence.factors.at(-1)?.name).toBe(OFFLINE_CACHE_FACTOR_NAME);
    expect(degraded.confidence.factors.at(-1)?.contribution).toBeLessThan(0);
    // The original object is untouched.
    expect(signal.confidence.degradedByOfflineCache).toBe(false);
    expect(signal.confidence.value).toBe(0.72);
  });

  it("is idempotent: a second pass does not compound the penalty", () => {
    const once = degradeSignalForOfflineCache(makeSignal("sig-1"), { now: NOW });
    const twice = degradeSignalForOfflineCache(once, { now: NOW });
    expect(twice).toBe(once);
    expect(twice.confidence.factors.filter((f) => f.name === OFFLINE_CACHE_FACTOR_NAME)).toHaveLength(1);
  });

  it("accepts an explicit factor and clamps the result to [0,1]", () => {
    const confidence = makeSignal("sig-1", { confidence: 0.9 }).confidence;
    const degraded = degradeConfidenceForOfflineCache(confidence, { now: NOW, factor: 2 });
    expect(degraded.value).toBeLessThanOrEqual(1);
    expect(degraded.value).toBeGreaterThanOrEqual(0);
  });
});

describe("offline overlay degradation", () => {
  it("marks the overlay and every segment stale, and exposes the reason", () => {
    const overlay = makeOverlay({
      asOf: "2025-01-02T00:35:00.000Z",
      generatedAt: "2025-01-02T00:35:00.000Z",
      source: "live",
      isStale: false,
      segments: [makeSegmentRisk(SEGMENT_KJ, { confidence: 0.8 })],
    });

    const degraded = degradeOverlayForOfflineCache(overlay, { now: NOW });

    expect(degraded.overlay.source).toBe("cache");
    expect(degraded.overlay.isStale).toBe(true);
    expect(degraded.overlay.stalenessMinutes).toBe(7);
    expect(degraded.overlay.segments.every((segment) => segment.stale)).toBe(true);
    expect(degraded.overlay.segments[0].confidence).toBeCloseTo(0.8 * OFFLINE_CONFIDENCE_FACTOR, 10);
    // The estimate itself is not silently rewritten — only its confidence is.
    expect(degraded.overlay.segments[0].degradationProbability).toBe(
      overlay.segments[0].degradationProbability,
    );
    expect(degraded.label).toBe("as of 08:35, 7 min ago");
    expect(degraded.reason).toBe(
      "Offline: showing cached disruption data (as of 08:35, 7 min ago); confidence reduced.",
    );
  });

  it("has a Bahasa Malaysia reason variant", () => {
    expect(offlineReason("2025-01-02T00:35:00.000Z", NOW, { locale: "ms" })).toBe(
      "Luar talian: memaparkan data gangguan yang disimpan (setakat 08:35, 7 minit lalu); keyakinan dikurangkan.",
    );
  });
});

/**
 * Client-side API access. Everything goes through the `ApiResponse<T>` envelope
 * from the frozen contracts, so a stale client can detect a schema mismatch and
 * an error carries a localisable `messageKey`.
 *
 * No module here imports `lib/mock/**`: the browser only ever talks to
 * `app/api/**`, which is what makes the data-source seam invisible to the UI.
 */
import type {
  ApiMeta,
  ApiResponse,
  DisruptionSignal,
  Line,
  PlanRouteResponse,
  ReconcileResponse,
  RiskOverlay,
  Segment,
  SourceInspectorResponse,
  Station,
} from "@/lib/contracts";

export interface Envelope<T> {
  data: T;
  meta: ApiMeta;
}

export class ApiError extends Error {
  readonly code: string;
  readonly messageKey?: string;
  readonly meta: ApiMeta;

  constructor(code: string, message: string, meta: ApiMeta, messageKey?: string) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.messageKey = messageKey;
    this.meta = meta;
  }
}

const EMPTY_META: ApiMeta = {
  generatedAt: new Date(0).toISOString(),
  cached: true,
  asOf: new Date(0).toISOString(),
  stalenessMinutes: 0,
  contractsVersion: "unknown",
};

async function request<T>(url: string, init?: RequestInit): Promise<Envelope<T>> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers: { accept: "application/json", ...(init?.headers ?? {}) },
    });
  } catch (cause) {
    throw new ApiError(
      "NETWORK",
      cause instanceof Error ? cause.message : "Network request failed",
      EMPTY_META,
      "offline.banner",
    );
  }

  let body: ApiResponse<T>;
  try {
    body = (await response.json()) as ApiResponse<T>;
  } catch {
    throw new ApiError("INTERNAL", `Malformed response from ${url}`, EMPTY_META, "common.error");
  }

  if (!body.ok) {
    throw new ApiError(body.error.code, body.error.message, body.meta, body.error.messageKey);
  }
  return { data: body.data, meta: body.meta };
}

export interface NetworkPayloadClient {
  lines: Line[];
  stations: Station[];
  segments: Segment[];
  source: {
    kind: "mock" | "live";
    topologySource: "artifact" | "fixture";
    topologyPath: string;
    stationCount: number;
    segmentCount: number;
    lineCount: number;
    signalCount: number;
    notes: string[];
  };
  defaultOriginStationId: string;
  defaultDestinationStationId: string;
}

export function fetchNetwork(mode: "cache" | "live" = "cache") {
  return request<NetworkPayloadClient>(`/api/network?mode=${mode}`);
}

export function fetchSignals(mode: "cache" | "live" = "cache", since?: string) {
  const suffix = since ? `&since=${encodeURIComponent(since)}` : "";
  return request<{ signals: DisruptionSignal[]; changedSince?: DisruptionSignal[] }>(
    `/api/signals?mode=${mode}${suffix}`,
  );
}

export function fetchOverlay(mode: "cache" | "live" = "cache") {
  return request<{ overlay: RiskOverlay }>(`/api/risk?mode=${mode}`);
}

export function fetchRoute(
  origin: string,
  destination: string,
  mode: "cache" | "live" = "cache",
  options?: { maxItineraries?: number; maxTransfers?: number },
) {
  const params = new URLSearchParams({ origin, destination, mode });
  if (options?.maxItineraries) params.set("maxItineraries", String(options.maxItineraries));
  if (options?.maxTransfers !== undefined) params.set("maxTransfers", String(options.maxTransfers));
  return request<PlanRouteResponse>(`/api/route?${params.toString()}`);
}

export function fetchSourceTrace(signalId: string) {
  return request<SourceInspectorResponse>(`/api/source/${encodeURIComponent(signalId)}`);
}

export function fetchReconcile(since: string) {
  return request<ReconcileResponse>(`/api/reconcile?since=${encodeURIComponent(since)}`);
}

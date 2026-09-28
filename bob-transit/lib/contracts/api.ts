/**
 * FROZEN CONTRACT — do not modify.
 *
 * HTTP envelope shared by every API route. ONE Next.js deployment serves both UI
 * and API; there is no separate backend process.
 */

import type { RouteAdvisory, RouteQuery } from "./routing";
import type { DisruptionSignal } from "./signal";
import type { RiskOverlay } from "./risk";

export interface ApiMeta {
  generatedAt: string;
  /** True when the payload was served from cache rather than freshly computed. */
  cached: boolean;
  asOf: string;
  stalenessMinutes: number;
  /** Contracts version, so a stale client can detect a schema mismatch. */
  contractsVersion: string;
}

export interface ApiOk<T> {
  ok: true;
  data: T;
  meta: ApiMeta;
}

export interface ApiErr {
  ok: false;
  error: {
    code:
      | "BAD_REQUEST"
      | "NOT_FOUND"
      | "NO_ROUTE"
      | "OFFLINE_NO_CACHE"
      | "UPSTREAM_UNAVAILABLE"
      | "INTERNAL";
    message: string;
    /** User-facing, localised message key resolved by the UI. */
    messageKey?: string;
    detail?: string;
  };
  meta: ApiMeta;
}

export type ApiResponse<T> = ApiOk<T> | ApiErr;

/* ---------- Route payloads ---------- */

export interface PlanRouteRequest extends RouteQuery {}

export interface PlanRouteResponse {
  advisory: RouteAdvisory;
}

/* ---------- Signal payloads ---------- */

export interface SignalsResponse {
  signals: DisruptionSignal[];
  /** Signals that changed since the client's `since` cursor — used on reconnect. */
  changedSince?: DisruptionSignal[];
}

export interface RiskOverlayResponse {
  overlay: RiskOverlay;
}

/* ---------- Source Inspector ---------- */

export interface SourceInspectorTrace {
  signalId: string;
  /** The claim being explained, in plain language. */
  claim: string;
  steps: Array<{
    label: string;
    detail: string;
    confidence: number;
    /** Which sources/segments this step rests on. */
    refs: string[];
  }>;
  /** Confidence at each pipeline hop, for the A3 replay requirement. */
  confidenceByHop: Array<{ hop: string; confidence: number; at: string }>;
}

export interface SourceInspectorResponse {
  trace: SourceInspectorTrace;
}

/* ---------- Reconnect reconciliation ---------- */

export interface ReconcileRequest {
  /** ISO timestamp of the client's last successful sync. */
  since: string;
}

export interface ReconcileResponse {
  changedSignals: DisruptionSignal[];
  clearedSignalIds: string[];
  newSignalIds: string[];
  overlay: RiskOverlay;
  serverTime: string;
}

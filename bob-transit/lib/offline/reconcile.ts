/**
 * Reconnect reconciliation.
 *
 * The phone comes out of the tunnel with a cached signal set and a cursor. The
 * server has moved on. This module compares the two and classifies every
 * difference — new signals, cleared signals, and signals whose confidence or
 * status changed — in the shape of the frozen `ReconcileResponse` contract.
 *
 * It is pure: no network, no clock. `since` and `serverTime` come from the caller.
 */

import type { ReconcileResponse } from "@/lib/contracts/api";
import type { DisruptionSignal, SignalStatus } from "@/lib/contracts/signal";
import type { RiskOverlay } from "@/lib/contracts/risk";
import { formatClockTime, type StalenessLocale } from "./staleness";

/** A signal is "terminal" once it can no longer be acted on. */
const TERMINAL_STATUSES: readonly SignalStatus[] = ["CLEARED", "REJECTED"];

export function isTerminalStatus(status: SignalStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/** Confidence deltas below this are float noise, not a change. */
const CONFIDENCE_EPSILON = 1e-9;

export type ChangeKind = "NEW" | "CLEARED" | "CONFIDENCE_UP" | "CONFIDENCE_DOWN" | "UPDATED";

export interface ReconcileChange {
  signalId: string;
  kind: ChangeKind;
  previousConfidence: number | null;
  confidence: number | null;
  previousStatus: SignalStatus | null;
  status: SignalStatus | null;
  /** One line, safe to show in the UI. */
  summary: string;
}

export interface ReconcileInput {
  /** The client's last successful sync (the cursor sent in `ReconcileRequest`). */
  since: string;
  /** The signal set as the device last knew it. */
  cachedSignals: readonly DisruptionSignal[];
  /**
   * The server's COMPLETE current signal set — `SignalsResponse.signals`, not the
   * `changedSince` subset. Passing only the changed subset would make every
   * unchanged signal look cleared.
   */
  serverSignals: readonly DisruptionSignal[];
  /** The server's freshly computed overlay, passed straight through. */
  overlay: RiskOverlay;
  /** Server time of this reconciliation; becomes the next cursor. */
  serverTime: string;
  locale?: StalenessLocale;
}

export interface ReconcileResult {
  /** Exactly the frozen contract shape — hand this to the API/client. */
  response: ReconcileResponse;
  /** Every classified difference, ordered by signal id. */
  changes: ReconcileChange[];
  unchangedSignalIds: string[];
  /**
   * The cached set with the server's changes applied: cleared signals removed,
   * new and updated signals replaced. Persist this after a successful reconcile.
   */
  nextSignals: DisruptionSignal[];
  /** One sentence for the UI, e.g. "2 new, 1 cleared since 08:30". */
  summary: string;
  /** The cursor to use on the next reconnect. */
  cursor: string;
}

function byId(signals: readonly DisruptionSignal[]): Map<string, DisruptionSignal> {
  const map = new Map<string, DisruptionSignal>();
  for (const signal of signals) map.set(signal.id, signal);
  return map;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function describeChange(
  kind: ChangeKind,
  previous: DisruptionSignal | null,
  next: DisruptionSignal | null,
  locale: StalenessLocale,
): string {
  const id = next?.id ?? previous?.id ?? "unknown";
  const issue = (next ?? previous)?.issueType ?? "UNKNOWN";
  switch (kind) {
    case "NEW":
      return locale === "ms"
        ? `Gangguan baharu ${issue} (${id}) dilaporkan.`
        : `New ${issue} signal (${id}) reported.`;
    case "CLEARED":
      return locale === "ms"
        ? `Gangguan ${issue} (${id}) telah selesai.`
        : `${issue} signal (${id}) has cleared.`;
    case "CONFIDENCE_UP":
      return locale === "ms"
        ? `Keyakinan ${id} meningkat ${previous?.confidence.value.toFixed(2)} → ${next?.confidence.value.toFixed(2)}.`
        : `Confidence for ${id} rose ${previous?.confidence.value.toFixed(2)} → ${next?.confidence.value.toFixed(2)}.`;
    case "CONFIDENCE_DOWN":
      return locale === "ms"
        ? `Keyakinan ${id} menurun ${previous?.confidence.value.toFixed(2)} → ${next?.confidence.value.toFixed(2)}.`
        : `Confidence for ${id} fell ${previous?.confidence.value.toFixed(2)} → ${next?.confidence.value.toFixed(2)}.`;
    default:
      return locale === "ms"
        ? `Gangguan ${issue} (${id}) dikemas kini.`
        : `${issue} signal (${id}) updated.`;
  }
}

function classifyChange(
  previous: DisruptionSignal,
  next: DisruptionSignal,
): ChangeKind | null {
  const statusChanged = previous.status !== next.status;
  const severityChanged = previous.severity !== next.severity;
  const issueChanged = previous.issueType !== next.issueType;
  const confidenceDelta = next.confidence.value - previous.confidence.value;
  const confidenceChanged = Math.abs(confidenceDelta) > CONFIDENCE_EPSILON;
  const updatedAtChanged = previous.updatedAt !== next.updatedAt;

  if (confidenceChanged && !statusChanged && !severityChanged && !issueChanged) {
    return confidenceDelta > 0 ? "CONFIDENCE_UP" : "CONFIDENCE_DOWN";
  }
  if (statusChanged || severityChanged || issueChanged || confidenceChanged || updatedAtChanged) {
    return "UPDATED";
  }
  return null;
}

/**
 * Compare cached vs server state and classify every difference.
 */
export function reconcile(input: ReconcileInput): ReconcileResult {
  const locale = input.locale ?? "en";
  const cachedById = byId(input.cachedSignals);
  const serverById = byId(input.serverSignals);

  const newSignalIds: string[] = [];
  const clearedSignalIds: string[] = [];
  const changedSignals: DisruptionSignal[] = [];
  const changes: ReconcileChange[] = [];
  const unchangedSignalIds: string[] = [];

  // Signals the device already knew about.
  for (const cached of input.cachedSignals) {
    const server = serverById.get(cached.id);
    const serverIsTerminal = server ? isTerminalStatus(server.status) : false;

    if (!server || serverIsTerminal) {
      // Already known to be cleared on this device: not news.
      if (isTerminalStatus(cached.status)) {
        unchangedSignalIds.push(cached.id);
        continue;
      }
      clearedSignalIds.push(cached.id);
      changes.push({
        signalId: cached.id,
        kind: "CLEARED",
        previousConfidence: cached.confidence.value,
        confidence: server ? server.confidence.value : null,
        previousStatus: cached.status,
        status: server ? server.status : null,
        summary: describeChange("CLEARED", cached, server ?? null, locale),
      });
      continue;
    }

    const kind = classifyChange(cached, server);
    if (kind) {
      changedSignals.push(server);
      changes.push({
        signalId: server.id,
        kind,
        previousConfidence: cached.confidence.value,
        confidence: server.confidence.value,
        previousStatus: cached.status,
        status: server.status,
        summary: describeChange(kind, cached, server, locale),
      });
    } else {
      unchangedSignalIds.push(server.id);
    }
  }

  // Signals the server has that the device has never seen.
  for (const server of input.serverSignals) {
    if (cachedById.has(server.id)) continue;
    if (isTerminalStatus(server.status)) {
      // Nothing to act on; record it so the caller can see it was considered.
      unchangedSignalIds.push(server.id);
      continue;
    }
    newSignalIds.push(server.id);
    changes.push({
      signalId: server.id,
      kind: "NEW",
      previousConfidence: null,
      confidence: server.confidence.value,
      previousStatus: null,
      status: server.status,
      summary: describeChange("NEW", null, server, locale),
    });
  }

  const sortIds = (ids: string[]): string[] => [...ids].sort(compare);
  newSignalIds.sort(compare);
  clearedSignalIds.sort(compare);
  unchangedSignalIds.sort(compare);
  changes.sort((a, b) => compare(a.signalId, b.signalId));
  changedSignals.sort((a, b) => compare(a.id, b.id));

  const cleared = new Set(clearedSignalIds);
  const nextSignals = mergeNextSignals(input.cachedSignals, input.serverSignals, cleared, newSignalIds, changedSignals);

  const counts: string[] = [];
  if (newSignalIds.length > 0) {
    counts.push(locale === "ms" ? `${newSignalIds.length} baharu` : `${newSignalIds.length} new`);
  }
  if (clearedSignalIds.length > 0) {
    counts.push(locale === "ms" ? `${clearedSignalIds.length} selesai` : `${clearedSignalIds.length} cleared`);
  }
  if (changedSignals.length > 0) {
    counts.push(locale === "ms" ? `${changedSignals.length} dikemas kini` : `${changedSignals.length} updated`);
  }
  const sinceClock = formatClockTime(input.since);
  const summary =
    counts.length === 0
      ? locale === "ms"
        ? `Tiada perubahan sejak ${sinceClock}.`
        : `No changes since ${sinceClock}.`
      : locale === "ms"
        ? `${counts.join(", ")} sejak ${sinceClock}.`
        : `${counts.join(", ")} since ${sinceClock}.`;

  const response: ReconcileResponse = {
    changedSignals,
    clearedSignalIds,
    newSignalIds,
    overlay: input.overlay,
    serverTime: input.serverTime,
  };

  return {
    response,
    changes,
    unchangedSignalIds,
    nextSignals,
    summary,
    cursor: input.serverTime,
  };
}

function mergeNextSignals(
  cachedSignals: readonly DisruptionSignal[],
  serverSignals: readonly DisruptionSignal[],
  cleared: ReadonlySet<string>,
  newSignalIds: readonly string[],
  changedSignals: readonly DisruptionSignal[],
): DisruptionSignal[] {
  const next = new Map<string, DisruptionSignal>();
  for (const signal of cachedSignals) {
    if (cleared.has(signal.id)) continue;
    if (isTerminalStatus(signal.status)) continue;
    next.set(signal.id, signal);
  }
  const replacements = new Map<string, DisruptionSignal>();
  for (const signal of changedSignals) replacements.set(signal.id, signal);
  const serverById = byId(serverSignals);
  for (const id of newSignalIds) {
    const signal = serverById.get(id);
    if (signal) replacements.set(id, signal);
  }
  for (const [id, signal] of replacements) next.set(id, signal);

  return [...next.values()].sort((a, b) => {
    if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? 1 : -1;
    return compare(a.id, b.id);
  });
}

/**
 * In-memory signal store: dedupe, merge and lifecycle.
 *
 * Deliberately not a database (out of scope, and S5 owns persistence). What it
 * does own is the *rule* that matters: when the same incident is seen twice, the
 * second sighting updates the first — it never creates a louder duplicate, and
 * an official confirmation is never undone by more social chatter.
 */

import type { DisruptionSignal, SignalStatus, SourceRef } from "@/lib/contracts";
import { isActiveAt } from "@/lib/contracts";

import { calibrateConfidence } from "./calibration";
import {
  type EvidenceSummary,
  leadTimeMinutes,
  mergeStatus,
  readEvidenceSummary,
  signalIdentityKey,
} from "./lifecycle";

export interface SignalStoreOptions {
  /** Injectable clock — the store never reads the wall clock itself. */
  now: () => Date;
  /** Two sightings further apart than this are separate incidents. */
  mergeWindowMinutes?: number;
  /** Guard rail so a long-running worker cannot grow without bound. */
  maxSignals?: number;
}

export interface UpsertResult {
  added: DisruptionSignal[];
  updated: DisruptionSignal[];
  cleared: DisruptionSignal[];
  unchanged: DisruptionSignal[];
  /** Signals displaced because a newer incident on the same identity arrived. */
  superseded: DisruptionSignal[];
}

const EMPTY_RESULT = (): UpsertResult => ({
  added: [],
  updated: [],
  cleared: [],
  unchanged: [],
  superseded: [],
});

interface Entry {
  signal: DisruptionSignal;
  evidence: EvidenceSummary;
  storedAt: string;
}

function evidenceFromSources(signal: DisruptionSignal): EvidenceSummary {
  const fromHop = readEvidenceSummary(signal);
  if (fromHop) return fromHop;
  const official = signal.sources.filter((s) => s.sourceClass === "OFFICIAL_STATEMENT");
  const realtime = signal.sources.filter((s) => s.sourceClass === "OFFICIAL_REALTIME");
  const socialAuthors = [
    ...new Set(
      signal.sources
        .filter((s) => s.sourceClass === "SOCIAL")
        .map((s) => s.authorId)
        .filter((x): x is string => typeof x === "string"),
    ),
  ];
  return {
    socialAuthors,
    officialStatementCount: official.length,
    realtimeObservationCount: realtime.length,
    operatorNotifiedAt: official.map((s) => s.publishedAt).sort()[0] ?? null,
    rejectedSourceIds: [],
    calibrationInput: null,
  };
}

function mergeSources(a: SourceRef[], b: SourceRef[]): SourceRef[] {
  const byHash = new Map<string, SourceRef>();
  for (const s of [...a, ...b]) {
    const existing = byHash.get(s.contentHash);
    if (!existing || s.publishedAt < existing.publishedAt) byHash.set(s.contentHash, s);
  }
  return [...byHash.values()].sort(
    (x, y) => x.publishedAt.localeCompare(y.publishedAt) || x.id.localeCompare(y.id),
  );
}

function mergeEvidence(a: EvidenceSummary, b: EvidenceSummary): EvidenceSummary {
  return {
    socialAuthors: [...new Set([...a.socialAuthors, ...b.socialAuthors])].sort(),
    officialStatementCount: a.officialStatementCount + b.officialStatementCount,
    realtimeObservationCount: a.realtimeObservationCount + b.realtimeObservationCount,
    operatorNotifiedAt:
      a.operatorNotifiedAt && b.operatorNotifiedAt
        ? a.operatorNotifiedAt < b.operatorNotifiedAt
          ? a.operatorNotifiedAt
          : b.operatorNotifiedAt
        : (a.operatorNotifiedAt ?? b.operatorNotifiedAt),
    rejectedSourceIds: [...new Set([...a.rejectedSourceIds, ...b.rejectedSourceIds])].sort(),
    // The newer sighting's quality context is the one that applies going forward.
    calibrationInput: b.calibrationInput ?? a.calibrationInput,
  };
}

export class SignalStore {
  private readonly entries = new Map<string, Entry>();
  private readonly rejectedSources = new Set<string>();
  private readonly now: () => Date;
  private readonly mergeWindowMinutes: number;
  private readonly maxSignals: number;

  constructor(options: SignalStoreOptions) {
    this.now = options.now;
    this.mergeWindowMinutes = options.mergeWindowMinutes ?? 180;
    this.maxSignals = options.maxSignals ?? 500;
  }

  /** Mark a source hash as permanently rejected so it cannot re-enter. */
  rejectSource(contentHash: string): void {
    this.rejectedSources.add(contentHash);
  }

  isSourceRejected(contentHash: string): boolean {
    return this.rejectedSources.has(contentHash);
  }

  get(id: string): DisruptionSignal | undefined {
    return this.entries.get(this.keyOfId(id))?.signal;
  }

  all(): DisruptionSignal[] {
    return [...this.entries.values()]
      .map((e) => e.signal)
      .sort((a, b) => a.firstSeenAt.localeCompare(b.firstSeenAt) || a.id.localeCompare(b.id));
  }

  /** Signals whose window covers `at`. */
  active(at: Date): DisruptionSignal[] {
    return this.all().filter((s) => isActiveAt(s, at) && s.status !== "REJECTED" && s.status !== "CLEARED");
  }

  /** Signals the operator has publicly acknowledged — the headline metric. */
  confirmed(): DisruptionSignal[] {
    return this.all().filter((s) => s.operatorNotifiedAt !== null);
  }

  clear(id: string): boolean {
    const key = this.keyOfId(id);
    const entry = this.entries.get(key);
    if (!entry) return false;
    const at = this.now().toISOString();
    entry.signal = {
      ...entry.signal,
      status: "CLEARED",
      updatedAt: at,
      window: { ...entry.signal.window, endsAt: entry.signal.window.endsAt ?? at },
    };
    return true;
  }

  reject(id: string, reason: string): boolean {
    const key = this.keyOfId(id);
    const entry = this.entries.get(key);
    if (!entry) return false;
    const at = this.now().toISOString();
    entry.signal = {
      ...entry.signal,
      status: "REJECTED",
      updatedAt: at,
      reasoning: reason.slice(0, 400),
      provenance: [
        ...entry.signal.provenance,
        { hop: "VERIFY", at, confidence: 0, summary: `rejected: ${reason}` },
      ],
    };
    return true;
  }

  /**
   * Insert or merge a batch of verified signals.
   *
   * Merging is where source precedence lives: the merged status can never fall
   * below the previous one unless the new evidence is an explicit recovery, and
   * an official acknowledgement, once seen, is kept forever.
   */
  upsert(incoming: DisruptionSignal[]): UpsertResult {
    const result = EMPTY_RESULT();
    const at = this.now().toISOString();

    for (const signal of [...incoming].sort((a, b) => a.firstSeenAt.localeCompare(b.firstSeenAt))) {
      if (signal.sources.some((s) => this.rejectedSources.has(s.contentHash))) {
        result.unchanged.push(signal);
        continue;
      }

      const identity = signalIdentityKey(signal);
      const existing = this.entries.get(identity);

      if (!existing) {
        this.entries.set(identity, {
          signal,
          evidence: evidenceFromSources(signal),
          storedAt: at,
        });
        result.added.push(signal);
        continue;
      }

      const gapMinutes =
        Math.abs(Date.parse(signal.window.startsAt) - Date.parse(existing.signal.window.startsAt)) /
        60_000;
      if (gapMinutes > this.mergeWindowMinutes) {
        this.entries.set(identity, {
          signal,
          evidence: evidenceFromSources(signal),
          storedAt: at,
        });
        result.superseded.push(existing.signal);
        result.added.push(signal);
        continue;
      }

      const merged = this.merge(existing, signal, at);
      if (merged === existing.signal) {
        result.unchanged.push(existing.signal);
        continue;
      }
      this.entries.set(identity, { ...existing, signal: merged, storedAt: at });
      if (merged.status === "CLEARED") result.cleared.push(merged);
      else if (merged.status === "REJECTED") result.unchanged.push(merged);
      else result.updated.push(merged);
    }

    this.evictIfNeeded(result);
    return result;
  }

  private merge(existing: Entry, incoming: DisruptionSignal, at: string): DisruptionSignal {
    const evidence = mergeEvidence(existing.evidence, evidenceFromSources(incoming));
    const sources = mergeSources(existing.signal.sources, incoming.sources);
    const previous = existing.signal;

    const input = evidence.calibrationInput;
    const confidence = calibrateConfidence({
      socialDistinctAuthors: evidence.socialAuthors.length,
      officialStatementCount: evidence.officialStatementCount,
      realtimeObservationCount: evidence.realtimeObservationCount,
      ...(input ?? {}),
      unresolved: previous.resolution === "UNRESOLVED" || incoming.resolution === "UNRESOLVED",
    });

    const operatorNotifiedAt = evidence.operatorNotifiedAt;
    const status = mergeStatus(previous.status, incoming.status);
    const firstSeenAt =
      previous.firstSeenAt < incoming.firstSeenAt ? previous.firstSeenAt : incoming.firstSeenAt;
    const startsAt =
      previous.window.startsAt < incoming.window.startsAt
        ? previous.window.startsAt
        : incoming.window.startsAt;
    const endsAt =
      previous.window.endsAt === null || incoming.window.endsAt === null
        ? null
        : previous.window.endsAt > incoming.window.endsAt
          ? previous.window.endsAt
          : incoming.window.endsAt;

    const unchanged =
      status === previous.status &&
      confidence.value === previous.confidence.value &&
      sources.length === previous.sources.length &&
      operatorNotifiedAt === previous.operatorNotifiedAt;
    if (unchanged) return previous;

    return {
      ...previous,
      updatedAt: at,
      status,
      sources,
      corroboratingSources: {
        official: evidence.officialStatementCount,
        socialDistinctAuthors: evidence.socialAuthors.length,
        realtimeObservations: evidence.realtimeObservationCount,
      },
      confidence,
      firstSeenAt,
      lastSeenAt:
        previous.lastSeenAt > incoming.lastSeenAt ? previous.lastSeenAt : incoming.lastSeenAt,
      operatorNotifiedAt,
      leadTimeMinutes: leadTimeMinutes(firstSeenAt, operatorNotifiedAt),
      window: { startsAt, endsAt },
      reasoning: `${previous.reasoning} ${incoming.reasoning}`.trim().slice(0, 600),
      provenance: [...previous.provenance, ...incoming.provenance.filter((h) => h.hop === "VERIFY")],
    };
  }

  private evictIfNeeded(result: UpsertResult): void {
    if (this.entries.size <= this.maxSignals) return;
    const ordered = [...this.entries.entries()].sort(
      (a, b) => a[1].storedAt.localeCompare(b[1].storedAt) || a[0].localeCompare(b[0]),
    );
    for (const [key, entry] of ordered) {
      if (this.entries.size <= this.maxSignals) break;
      if (entry.signal.status === "CONFIRMED") continue;
      this.entries.delete(key);
      result.superseded.push(entry.signal);
    }
  }

  private keyOfId(id: string): string {
    for (const [key, entry] of this.entries) if (entry.signal.id === id) return key;
    return id;
  }

  /** Serialisable snapshot for offline caching. */
  snapshot(): { signals: DisruptionSignal[]; rejectedSources: string[] } {
    return { signals: this.all(), rejectedSources: [...this.rejectedSources].sort() };
  }

  /** Rehydrate from `snapshot()`. */
  restore(snapshot: { signals: DisruptionSignal[]; rejectedSources: string[] }): void {
    this.entries.clear();
    this.rejectedSources.clear();
    for (const hash of snapshot.rejectedSources) this.rejectedSources.add(hash);
    const at = this.now().toISOString();
    for (const signal of snapshot.signals) {
      this.entries.set(signalIdentityKey(signal), {
        signal,
        evidence: evidenceFromSources(signal),
        storedAt: at,
      });
    }
  }

  /** Statuses currently held, for assertions and diagnostics. */
  statusCounts(): Record<SignalStatus, number> {
    const counts: Record<SignalStatus, number> = {
      CANDIDATE: 0,
      REPORTED: 0,
      CONFIRMED: 0,
      CLEARED: 0,
      REJECTED: 0,
    };
    for (const entry of this.entries.values()) counts[entry.signal.status] += 1;
    return counts;
  }
}

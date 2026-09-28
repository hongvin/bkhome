/**
 * Dedupe, repost collapsing and incident clustering.
 *
 * The single rule this module exists to enforce: **social confidence scales
 * with distinct authors, never with repost volume.** A thousand retweets of one
 * commuter is one witness. Everything here is about making that true
 * mechanically rather than by convention.
 */

import type { LineId, SegmentId, StationId } from "@/lib/contracts";
import { JUNK_QUALITY_THRESHOLD } from "@/lib/signals/calibration";
import { sha256Hex } from "@/lib/signals/hash";
import type { IngestCandidate } from "@/lib/signals/types";

/**
 * Identical text from two different authors is only treated as a repost when it
 * is long enough that coincidence is implausible, or when a repost marker was
 * detected. Two strangers independently posting "LRT rosak" are two witnesses.
 */
export const MIN_INCIDENTAL_REPOST_LENGTH = 40;

export interface DedupeResult {
  /** One canonical candidate per distinct piece of content. */
  unique: IngestCandidate[];
  /** candidate id -> canonical candidate id (only for collapsed duplicates). */
  collapsed: Map<string, string>;
  /** contentHash -> candidate ids, first-seen order. */
  groups: Map<string, string[]>;
}

function bySeenThenId(a: IngestCandidate, b: IngestCandidate): number {
  return (
    a.firstSeenAt.localeCompare(b.firstSeenAt) ||
    a.publishedAt.localeCompare(b.publishedAt) ||
    a.id.localeCompare(b.id)
  );
}

/**
 * Collapse duplicate content.
 *
 * Within one content hash (identical normalised text):
 *  - the same author posting twice is one witness;
 *  - an explicit repost marker, or text long enough that coincidence is
 *    implausible, collapses onto the earliest copy;
 *  - short identical text from *different* authors with no repost marker stays
 *    separate, because two strangers independently typing "LRT rosak" really are
 *    two witnesses.
 *
 * Separately, any record that declares `originalAuthorId` / `repostOfId` is
 * attributed to the earliest record from that original author.
 */
export function collapseReposts(candidates: IngestCandidate[]): DedupeResult {
  const groups = new Map<string, IngestCandidate[]>();
  for (const c of candidates) {
    const key = c.source.contentHash;
    const list = groups.get(key);
    if (list) list.push(c);
    else groups.set(key, [c]);
  }

  const earliestByAuthor = new Map<string, IngestCandidate>();
  for (const c of candidates) {
    const author = c.authenticity.effectiveAuthorId;
    if (!author) continue;
    const existing = earliestByAuthor.get(author);
    if (!existing || bySeenThenId(c, existing) < 0) earliestByAuthor.set(author, c);
  }

  const unique: IngestCandidate[] = [];
  const collapsed = new Map<string, string>();
  const groupIds = new Map<string, string[]>();

  for (const [hash, list] of groups) {
    const sorted = [...list].sort(bySeenThenId);
    groupIds.set(
      hash,
      sorted.map((c) => c.id),
    );

    const canonical = sorted[0];
    const keeps: IngestCandidate[] = [canonical];
    for (const other of sorted.slice(1)) {
      const sameAuthor =
        other.source.authorId !== undefined && other.source.authorId === canonical.source.authorId;
      const explicitRepost = other.authenticity.isRepost || canonical.authenticity.isRepost;
      const longEnoughToBeCopied =
        other.normalizedText.length >= MIN_INCIDENTAL_REPOST_LENGTH;
      if (sameAuthor || explicitRepost || longEnoughToBeCopied) {
        collapsed.set(other.id, canonical.id);
      } else {
        keeps.push(other);
      }
    }

    for (const kept of keeps) {
      const origin = earliestByAuthor.get(kept.authenticity.effectiveAuthorId ?? "");
      if (origin && origin.id !== kept.id && kept.authenticity.isRepost) {
        collapsed.set(kept.id, origin.id);
        continue;
      }
      unique.push(kept);
    }
  }

  unique.sort(bySeenThenId);
  return { unique, collapsed, groups: groupIds };
}

export interface DistinctAuthorSummary {
  /** Distinct effective author ids, sorted. Reposts resolve to the original. */
  authors: string[];
  /** Mean quality multiplier over the counted posts (0 when there are none). */
  quality: number;
  /** Posts dropped from corroboration because they were junk. */
  junkCount: number;
  /** Posts that carried no author identity at all. */
  anonymousCount: number;
}

/**
 * Count distinct social authors. `includeJunk` exists only so the INGEST
 * provenance hop can show the raw volume the Verifier had to work with.
 */
export function distinctSocialAuthors(
  candidates: IngestCandidate[],
  options: { includeJunk?: boolean } = {},
): DistinctAuthorSummary {
  const includeJunk = options.includeJunk ?? false;
  const authors = new Set<string>();
  let qualitySum = 0;
  let counted = 0;
  let junkCount = 0;
  let anonymousCount = 0;

  for (const c of candidates) {
    if (c.sourceClass !== "SOCIAL") continue;
    if (!includeJunk && c.authenticity.qualityMultiplier < JUNK_QUALITY_THRESHOLD) {
      junkCount += 1;
      continue;
    }
    const author = c.authenticity.effectiveAuthorId;
    if (author) authors.add(author);
    else {
      anonymousCount += 1;
      authors.add(`anon:${c.id}`);
    }
    qualitySum += c.authenticity.qualityMultiplier;
    counted += 1;
  }

  return {
    authors: [...authors].sort(),
    quality: counted === 0 ? 0 : qualitySum / counted,
    junkCount,
    anonymousCount,
  };
}

/* ------------------------------------------------------------------ *
 * Clustering
 * ------------------------------------------------------------------ */

export interface CandidateFootprint {
  segmentIds: SegmentId[];
  lineIds: LineId[];
  stationIds: StationId[];
  placeKeys: string[];
  /** Stable key used when two footprints share no concrete location. */
  locationKey: string;
  /** Issue type used to keep two location-less claims of different kinds apart. */
  issueType: string;
}

export interface ClusterOptions {
  /** Two pieces of evidence further apart than this never join one incident. */
  windowMinutes: number;
  footprintOf(candidate: IngestCandidate): CandidateFootprint;
}

export interface CandidateCluster {
  key: string;
  candidates: IngestCandidate[];
  /** Union footprint of every candidate in the cluster. */
  footprint: CandidateFootprint;
  firstSeenAt: string;
  lastPublishedAt: string;
}

function intersects(a: CandidateFootprint, b: CandidateFootprint): boolean {
  if (a.segmentIds.some((s) => b.segmentIds.includes(s))) return true;
  if (a.stationIds.some((s) => b.stationIds.includes(s))) return true;
  if (a.placeKeys.some((s) => b.placeKeys.includes(s))) return true;
  if (a.lineIds.some((s) => b.lineIds.includes(s))) return true;
  // Location-less claims only cluster with claims of the same kind.
  return a.locationKey === b.locationKey && a.locationKey === "NONE" && a.issueType === b.issueType;
}

function unionFootprint(a: CandidateFootprint, b: CandidateFootprint): CandidateFootprint {
  return {
    segmentIds: [...new Set([...a.segmentIds, ...b.segmentIds])].sort(),
    lineIds: [...new Set([...a.lineIds, ...b.lineIds])].sort(),
    stationIds: [...new Set([...a.stationIds, ...b.stationIds])].sort(),
    placeKeys: [...new Set([...a.placeKeys, ...b.placeKeys])].sort(),
    locationKey: a.locationKey === b.locationKey ? a.locationKey : "MIXED",
    issueType: a.issueType === b.issueType ? a.issueType : "MIXED",
  };
}

function clusterKeyOf(footprint: CandidateFootprint): string {
  const identity =
    footprint.segmentIds.length > 0
      ? footprint.segmentIds.join("|")
      : footprint.lineIds.length > 0
        ? `LINE:${footprint.lineIds.join("|")}`
        : footprint.placeKeys.length > 0
          ? footprint.placeKeys.join("|")
          : `NONE:${footprint.issueType}`;
  return identity;
}

/**
 * Group candidates into incidents: evidence joins a cluster when its footprint
 * intersects the cluster's and it falls inside the time window. Clustering is
 * order-independent for a fixed input set (candidates are sorted first).
 */
export function clusterCandidates(
  candidates: IngestCandidate[],
  options: ClusterOptions,
): CandidateCluster[] {
  const sorted = [...candidates].sort(bySeenThenId);
  const clusters: CandidateCluster[] = [];

  for (const candidate of sorted) {
    const footprint = options.footprintOf(candidate);
    let best: CandidateCluster | null = null;
    let bestOverlap = -1;
    for (const cluster of clusters) {
      const gap = Math.abs(Date.parse(candidate.publishedAt) - Date.parse(cluster.lastPublishedAt));
      if (gap > options.windowMinutes * 60_000) continue;
      if (!intersects(cluster.footprint, footprint)) continue;
      const overlap =
        footprint.segmentIds.filter((s) => cluster.footprint.segmentIds.includes(s)).length * 4 +
        footprint.stationIds.filter((s) => cluster.footprint.stationIds.includes(s)).length * 2 +
        footprint.lineIds.filter((s) => cluster.footprint.lineIds.includes(s)).length;
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        best = cluster;
      }
    }
    if (best) {
      best.candidates.push(candidate);
      best.footprint = unionFootprint(best.footprint, footprint);
      if (candidate.publishedAt > best.lastPublishedAt) best.lastPublishedAt = candidate.publishedAt;
      if (candidate.firstSeenAt < best.firstSeenAt) best.firstSeenAt = candidate.firstSeenAt;
    } else {
      clusters.push({
        key: clusterKeyOf(footprint),
        candidates: [candidate],
        footprint,
        firstSeenAt: candidate.firstSeenAt,
        lastPublishedAt: candidate.publishedAt,
      });
    }
  }

  // Re-key from the final footprint so the key is a property of the cluster, not
  // of whichever candidate happened to create it.
  const used = new Map<string, number>();
  for (const cluster of clusters) {
    const base = clusterKeyOf(cluster.footprint);
    const n = used.get(base) ?? 0;
    used.set(base, n + 1);
    cluster.key = n === 0 ? base : `${base}.${n}`;
  }

  return clusters.sort((a, b) => a.firstSeenAt.localeCompare(b.firstSeenAt) || a.key.localeCompare(b.key));
}

/** Deterministic signal id derived from identity, never from the wall clock. */
export function signalIdFor(parts: string[]): string {
  return `sig_${sha256Hex(parts.join("\u0000")).slice(0, 16)}`;
}

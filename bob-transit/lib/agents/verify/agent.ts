/**
 * Verify agent.
 *
 * Turns normalised candidates into `DisruptionSignal`s — or into nothing at all.
 *
 * The asymmetry that drives every decision here:
 *   a false positive sends thousands of commuters onto worse routes;
 *   a false negative leaves them stranded.
 * Under-calling is cheaper than inventing. When the evidence is thin, the
 * confidence goes down and the reason is written down; it is never rounded up.
 *
 * The agent is a deterministic rule engine. It has no model call and no network
 * access; `PROMPT.md` in this directory is its written specification, shipped so
 * a human can read the rules the code implements.
 */

import type {
  DisruptionSignal,
  IssueType,
  LineId,
  SegmentId,
  SignalProvenanceHop,
  SourceRef,
  StationId,
} from "@/lib/contracts";

import { runIngestAgent } from "@/lib/agents/ingest/agent";
import { type CorpusScenario, loadScenario, scenarioRecords } from "@/lib/agents/ingest/corpus";
import {
  CALIBRATION_VERSION,
  DEFAULT_WINDOW_MINUTES,
  REPORTABLE_CONFIDENCE,
  calibrateConfidence,
  isReportable,
} from "@/lib/signals/calibration";
import {
  type CandidateCluster,
  type CandidateFootprint,
  clusterCandidates,
  collapseReposts,
  distinctSocialAuthors,
  signalIdFor,
} from "@/lib/signals/dedupe";
import {
  type LocationResolution,
  resolveLocation,
  segmentsAtStations,
} from "@/lib/signals/entity-resolver";
import { leadTimeMinutes, signalIdentityKey, VERIFY_HOP_DATA_KEY } from "@/lib/signals/lifecycle";
import { aliasIndex, isCanonicalLineId, networkIndex } from "@/lib/signals";
import { deriveStatus } from "@/lib/signals/lifecycle";
import type { EvidenceSummary } from "@/lib/signals/lifecycle";
import type { IngestCandidate, RawSourceRecord } from "@/lib/signals/types";

import {
  checkStaleness,
  issueTypeFromObservation,
  issueVoteWeight,
  observationCountsAsEvidence,
  officialQualityFor,
  pickIssueType,
  pickSeverity,
} from "./rules";

export interface VerifyAgentInput {
  /** Raw captured records; normalised by the ingest agent inside this call. */
  records?: RawSourceRecord[];
  /** Or pass pre-normalised candidates if ingest already ran. */
  candidates?: IngestCandidate[];
  /** Reference instant, ISO-8601. REQUIRED — the agent never reads the clock. */
  now: string;
  /** Incident clustering window, minutes. Default 90. */
  windowMinutes?: number;
}

export interface RejectedClaim {
  clusterKey: string;
  reason: string;
  candidateIds: string[];
  /** Raw (pre-verification) evidence volume for this cluster. */
  confidence: number;
  /** The INGEST and VERIFY hops, so a rejection is auditable too. */
  hops: SignalProvenanceHop[];
}

export interface VerificationResult {
  signals: DisruptionSignal[];
  rejected: RejectedClaim[];
  candidates: IngestCandidate[];
  hops: SignalProvenanceHop[];
}

/* ------------------------------------------------------------------ *
 * Location
 * ------------------------------------------------------------------ */

function resolveCandidate(candidate: IngestCandidate): LocationResolution {
  const index = networkIndex();
  const aliases = aliasIndex();

  // OFFICIAL_REALTIME carries machine location, which outranks any text parse.
  if (candidate.observedStationId) {
    const station = index.stationById.get(candidate.observedStationId);
    if (station) {
      const place = aliases.placeByStation.get(station.id);
      const stationIds = (place?.stationIds ?? [station.id]).slice().sort();
      const lineIds = station.lineIds.filter(isCanonicalLineId).sort();
      return {
        resolution: "RESOLVED",
        strategy: "STATION",
        stationIds,
        lineIds,
        mentionedLineIds:
          candidate.observedLineId && isCanonicalLineId(candidate.observedLineId)
            ? [candidate.observedLineId]
            : [],
        segmentIds: segmentsAtStations(index, stationIds),
        unresolvedCandidates: [],
        locationConfidence: 0.9,
        reasons: [`realtime telemetry placed this at ${station.name} (${station.id})`],
        matchedNames: [station.name],
      };
    }
  }

  return resolveLocation(candidate.normalizedText, index, aliases, {
    extraStationMentions: candidate.parse.stationMentions,
    extraLineMentions: candidate.parse.lineMentions,
  });
}

function placeKeysFor(resolution: LocationResolution): string[] {
  const aliases = aliasIndex();
  const ids = new Set<StationId>(resolution.stationIds);
  if (resolution.unresolvedCandidates.length > 0) {
    for (const segmentId of resolution.unresolvedCandidates) {
      const segment = networkIndex().segmentById.get(segmentId);
      if (segment) {
        ids.add(segment.fromStationId);
        ids.add(segment.toStationId);
      }
    }
  }
  return [
    ...new Set(
      [...ids].map((id) => aliases.placeByStation.get(id)?.key).filter((x): x is string => !!x),
    ),
  ].sort();
}

/* ------------------------------------------------------------------ *
 * Cluster evaluation
 * ------------------------------------------------------------------ */

interface Evaluated {
  candidate: IngestCandidate;
  resolution: LocationResolution;
  staleReason: string | null;
}

interface ClusterShape {
  resolution: "RESOLVED" | "UNRESOLVED";
  segmentIds: SegmentId[];
  stationIds: StationId[];
  lineIds: LineId[];
  unresolvedCandidates: SegmentId[];
  mentionedLines: LineId[];
}

/**
 * Combine the per-candidate resolutions into the cluster's location.
 *
 * When at least one witness resolved to a segment we use segments. When the
 * cluster named a line, segments from the interchange's *other* line are
 * filtered out — but only using lines the text actually named, never a guess.
 * When nothing resolved we stay UNRESOLVED and carry every candidate.
 */
function shapeOfCluster(evaluated: Evaluated[]): ClusterShape {
  const resolved = evaluated.filter((e) => e.resolution.resolution === "RESOLVED");
  const mentionedLines = [
    ...new Set(evaluated.flatMap((e) => e.resolution.mentionedLineIds)),
  ].filter(isCanonicalLineId).sort() as LineId[];

  if (resolved.length > 0) {
    // The most specific location evidence wins: if any witness named both
    // endpoints ("antara KLCC dan Ampang Park") that beats a witness that only
    // named one station, without discarding the second witness's *confidence*
    // contribution.
    const precise = resolved.filter((e) => e.resolution.strategy === "SEGMENT_BETWEEN");
    const basis = precise.length > 0 ? precise : resolved;
    let segmentIds = [...new Set(basis.flatMap((e) => e.resolution.segmentIds))].sort();
    if (mentionedLines.length > 0) {
      segmentIds = segmentIds.filter((id) => {
        const segment = networkIndex().segmentById.get(id);
        return segment ? mentionedLines.includes(segment.lineId) : false;
      });
    }
    if (segmentIds.length > 0) {
      const stationIds = [...new Set(basis.flatMap((e) => e.resolution.stationIds))].sort();
      const lineIds = (
        mentionedLines.length > 0
          ? mentionedLines
          : [...new Set(basis.flatMap((e) => e.resolution.lineIds))]
      )
        .filter(isCanonicalLineId)
        .sort() as LineId[];
      return {
        resolution: "RESOLVED",
        segmentIds,
        stationIds,
        lineIds,
        unresolvedCandidates: [],
        mentionedLines,
      };
    }
  }

  const unresolvedCandidates = [
    ...new Set(evaluated.flatMap((e) => e.resolution.unresolvedCandidates)),
  ].sort();
  const lineIds = [...new Set(evaluated.flatMap((e) => e.resolution.lineIds))]
    .filter(isCanonicalLineId)
    .sort() as LineId[];
  return {
    resolution: "UNRESOLVED",
    segmentIds: [],
    stationIds: [],
    lineIds,
    unresolvedCandidates,
    mentionedLines,
  };
}

function summariseLocation(shape: ClusterShape): string {
  if (shape.resolution === "RESOLVED") {
    return `${shape.segmentIds.length} directed segment(s) on ${shape.lineIds.join("/") || "?"} (${shape.segmentIds.slice(0, 3).join(", ")}${shape.segmentIds.length > 3 ? ", ..." : ""})`;
  }
  if (shape.unresolvedCandidates.length > 0) {
    return `UNRESOLVED — ${shape.unresolvedCandidates.length} candidate segment(s) listed, none chosen`;
  }
  return "UNRESOLVED — no locatable segment";
}

function buildReasoning(args: {
  issueType: IssueType;
  shape: ClusterShape;
  socialAuthors: number;
  officialCount: number;
  realtimeCount: number;
  junkCount: number;
  value: number;
  band: string;
  windowMinutes: number;
  extra: string;
}): string {
  const evidence: string[] = [];
  if (args.socialAuthors > 0) evidence.push(`${args.socialAuthors} distinct author(s)`);
  if (args.officialCount > 0) evidence.push(`${args.officialCount} official statement(s)`);
  if (args.realtimeCount > 0) evidence.push(`${args.realtimeCount} realtime observation(s)`);
  if (args.junkCount > 0) evidence.push(`${args.junkCount} post(s) dropped as junk`);
  const where =
    args.shape.resolution === "RESOLVED"
      ? args.shape.segmentIds.slice(0, 2).join(", ")
      : `${args.shape.unresolvedCandidates.length} candidate segment(s)`;
  const first =
    `${evidence.length > 0 ? evidence.join(", ") : "no evidence"} for ${args.issueType} at ${where} ` +
    `within a ${args.windowMinutes} min window.`;
  const second =
    ` Calibrated ${args.value.toFixed(3)} (${args.band}, ${CALIBRATION_VERSION}); ${args.extra}`;
  return `${first}${second}`.slice(0, 600);
}

/**
 * The trailing clause of `reasoning`. It is COMPUTED from the same counts that
 * populate `corroboratingSources`, so the sentence can never contradict the
 * signal's own provenance — that contradiction is precisely the kind of
 * overstatement this product cannot afford.
 */
function reasoningSuffix(args: {
  officialCount: number;
  officialDenial: boolean;
  unresolved: boolean;
  socialAuthors: number;
  junkCount: number;
}): string {
  const clauses: string[] = [];
  if (args.officialDenial) {
    clauses.push("an official source reports normal service");
  } else if (args.officialCount > 0) {
    clauses.push(
      `${args.officialCount} official statement(s) corroborate, so the score is operator-confirmed`,
    );
  } else {
    clauses.push("no official statement yet");
  }
  if (args.unresolved) clauses.push("location unresolved, so the score is capped");
  if (args.junkCount > 0) clauses.push(`${args.junkCount} post(s) discarded as sarcasm/joke/stale`);
  if (args.socialAuthors === 0 && args.officialCount === 0) clauses.push("no social corroboration");
  return `${clauses.join("; ")}.`;
}

/* ------------------------------------------------------------------ *
 * The agent
 * ------------------------------------------------------------------ */

export function runVerifyAgent(input: VerifyAgentInput): VerificationResult {
  const nowMs = Date.parse(input.now);
  if (!Number.isFinite(nowMs)) {
    throw new Error(`runVerifyAgent: invalid "now" instant "${input.now}"`);
  }
  const windowMinutes = input.windowMinutes ?? DEFAULT_WINDOW_MINUTES;

  const candidates =
    input.candidates ??
    runIngestAgent({ records: input.records ?? [], now: input.now }).candidates;

  // 1. Identical content and reposts collapse BEFORE anything is counted, so
  //    repost volume can never become corroboration.
  const { unique } = collapseReposts(candidates);

  // 2. Resolve each distinct claim to a location (or refuse to).
  const resolutions = new Map<string, LocationResolution>();
  for (const c of unique) resolutions.set(c.id, resolveCandidate(c));

  // 3. Cluster into incidents by location overlap inside the time window.
  const footprintOf = (c: IngestCandidate): CandidateFootprint => {
    const r = resolutions.get(c.id) as LocationResolution;
    return {
      segmentIds: r.segmentIds,
      lineIds: r.lineIds,
      stationIds: r.stationIds,
      placeKeys: placeKeysFor(r),
      locationKey:
        r.segmentIds.length > 0
          ? r.segmentIds.join("|")
          : r.lineIds.length > 0
            ? `LINE:${r.lineIds.join("|")}`
            : "NONE",
      issueType: c.parse.issueType,
    };
  };
  const clusters = clusterCandidates(unique, { windowMinutes, footprintOf });

  const signals: DisruptionSignal[] = [];
  const rejected: RejectedClaim[] = [];

  for (const cluster of clusters) {
    const evaluated: Evaluated[] = cluster.candidates.map((candidate) => {
      const verdict = checkStaleness(candidate, nowMs, windowMinutes);
      return {
        candidate,
        resolution: resolutions.get(candidate.id) as LocationResolution,
        staleReason: verdict.stale ? verdict.reason : null,
      };
    });

    const live = evaluated.filter((e) => e.staleReason === null);
    const stale = evaluated.filter((e) => e.staleReason !== null);
    const allSocial = evaluated.filter((e) => e.candidate.sourceClass === "SOCIAL");
    const rawSocial = distinctSocialAuthors(
      allSocial.map((e) => e.candidate),
      { includeJunk: true },
    );
    const officialsAll = live.filter((e) => e.candidate.sourceClass === "OFFICIAL_STATEMENT");
    const realtimeAll = live.filter((e) => e.candidate.sourceClass === "OFFICIAL_REALTIME");

    // The INGEST hop: what the evidence looked like before the Verifier touched
    // it. Junk, stale quotes and reposts are all still in this number.
    const ingestScore = calibrateConfidence({
      socialDistinctAuthors: rawSocial.authors.length,
      officialStatementCount: officialsAll.length,
      realtimeObservationCount: realtimeAll.length,
      windowMinutes,
    });
    const ingestHop: SignalProvenanceHop = {
      hop: "INGEST",
      at: input.now,
      confidence: ingestScore.value,
      summary:
        `raw evidence: ${rawSocial.authors.length} distinct social author(s) (junk and stale ` +
        `quotes not yet excluded), ${officialsAll.length} official statement(s), ` +
        `${realtimeAll.length} realtime observation(s)`,
      data: {
        candidateIds: cluster.candidates.map((c) => c.id),
        collapsedFrom: candidates.length,
        staleCandidateIds: stale.map((e) => e.candidate.id),
        ingestConfidences: cluster.candidates.map((c) => ({
          id: c.id,
          value: c.ingestConfidence,
          sourceClass: c.sourceClass,
        })),
      },
    };

    const reject = (reason: string): void => {
      const verifyHop: SignalProvenanceHop = {
        hop: "VERIFY",
        at: input.now,
        confidence: 0,
        summary: `rejected: ${reason}`,
        data: { reason, issueType: cluster.candidates[0]?.parse.issueType ?? "UNKNOWN" },
      };
      rejected.push({
        clusterKey: cluster.key,
        reason,
        candidateIds: cluster.candidates.map((c) => c.id),
        confidence: ingestScore.value,
        hops: [ingestHop, verifyHop],
      });
    };

    if (live.length === 0) {
      reject(
        `every candidate in this cluster is stale (${stale.map((e) => e.staleReason).join("; ")})`,
      );
      continue;
    }

    // ---- source precedence ------------------------------------------------
    const officials = officialsAll.filter((e) => !e.candidate.parse.recovery);
    const recovery = officialsAll.some((e) => e.candidate.parse.recovery);
    const realtimeNormal = realtimeAll.some((e) => e.candidate.observation === "SERVICE_NORMAL");
    const officialDenial = recovery || realtimeNormal;
    const qualifyingRealtime = realtimeAll.filter((e) =>
      observationCountsAsEvidence(e.candidate.observation),
    );

    const socials = live.filter((e) => e.candidate.sourceClass === "SOCIAL");
    const socialSummary = distinctSocialAuthors(socials.map((e) => e.candidate));

    // ---- location ---------------------------------------------------------
    const shape = shapeOfCluster(live);

    // ---- issue type -------------------------------------------------------
    const votes = new Map<IssueType, number>();
    for (const e of live) {
      const type = e.candidate.observation
        ? issueTypeFromObservation(e.candidate.observation)
        : e.candidate.parse.issueType;
      if (!type) continue;
      const weight = issueVoteWeight(e.candidate);
      if (weight <= 0) continue;
      votes.set(type, (votes.get(type) ?? 0) + weight);
    }
    const vote = pickIssueType(votes);
    const issueType = vote.issueType;
    const severity = pickSeverity(
      live.map((e) => e.candidate),
      issueType,
    );

    // ---- calibration ------------------------------------------------------
    const officialQuality =
      officials.length === 0
        ? 1
        : officialQualityFor(
            officials.flatMap((e) => e.resolution.segmentIds),
            officials.flatMap((e) => e.resolution.mentionedLineIds),
            shape.segmentIds,
            shape.lineIds,
          );
    const realtimeQuality =
      qualifyingRealtime.length === 0
        ? 1
        : qualifyingRealtime.every((e) => e.resolution.lineIds.some((l) => shape.lineIds.includes(l)))
          ? 1
          : 0.6;

    const countedSocialPublished = socials
      .filter((e) => e.candidate.authenticity.qualityMultiplier >= 0.5)
      .map((e) => Date.parse(e.candidate.publishedAt))
      .filter((t) => Number.isFinite(t));
    const newestSocialAgeMinutes =
      countedSocialPublished.length === 0
        ? null
        : Math.max(0, (nowMs - Math.max(...countedSocialPublished)) / 60_000);

    const calibrationInput = {
      socialDistinctAuthors: socialSummary.authors.length,
      officialStatementCount: officials.length,
      realtimeObservationCount: qualifyingRealtime.length,
      socialQuality: socialSummary.authors.length === 0 ? 0 : socialSummary.quality,
      officialQuality,
      realtimeQuality,
      newestSocialAgeMinutes,
      windowMinutes,
      unresolved: shape.resolution === "UNRESOLVED",
      officialDenial,
      degradedByOfflineCache: false,
    };
    const confidence = calibrateConfidence(calibrationInput);

    if (!isReportable(confidence)) {
      reject(
        `calibrated ${confidence.value.toFixed(3)} (${confidence.band}) is below the reportable ` +
          `threshold ${REPORTABLE_CONFIDENCE}` +
          (officialDenial ? "; an official source reports normal service" : "") +
          (socialSummary.junkCount > 0
            ? `; ${socialSummary.junkCount} post(s) discarded as sarcasm/joke/stale`
            : "") +
          (shape.resolution === "UNRESOLVED" ? "; location unresolved" : ""),
      );
      continue;
    }

    // ---- assemble ---------------------------------------------------------
    const firstSeenAt = live
      .map((e) => e.candidate.firstSeenAt)
      .concat(cluster.candidates.map((c) => c.firstSeenAt))
      .sort()[0];
    const lastSeenAt = cluster.candidates.map((c) => c.publishedAt).sort().slice(-1)[0];
    const windowStartsAt = live.map((e) => e.candidate.publishedAt).sort()[0];
    const operatorNotifiedAt = officials.map((e) => e.candidate.publishedAt).sort()[0] ?? null;

    const sources: SourceRef[] = [...cluster.candidates]
      .map((c) => c.source)
      .sort((a, b) => a.publishedAt.localeCompare(b.publishedAt) || a.id.localeCompare(b.id));

    const status = deriveStatus({
      confidenceValue: confidence.value,
      hasOfficialStatement: officials.length > 0,
      recovery,
    });

    const evidenceSummary: EvidenceSummary = {
      socialAuthors: socialSummary.authors,
      officialStatementCount: officials.length,
      realtimeObservationCount: qualifyingRealtime.length,
      operatorNotifiedAt,
      rejectedSourceIds: socials
        .filter((e) => e.candidate.authenticity.qualityMultiplier < 0.5)
        .map((e) => e.candidate.id)
        .concat(stale.map((e) => e.candidate.id))
        .sort(),
      calibrationInput: {
        socialQuality: calibrationInput.socialQuality,
        officialQuality,
        realtimeQuality,
        newestSocialAgeMinutes,
        windowMinutes,
        unresolved: shape.resolution === "UNRESOLVED",
        officialDenial,
        degradedByOfflineCache: false,
      },
    };

    const verifyHop: SignalProvenanceHop = {
      hop: "VERIFY",
      at: input.now,
      confidence: confidence.value,
      summary:
        `verified ${issueType}/${severity} at ${summariseLocation(shape)}: ` +
        `${socialSummary.authors.length} distinct author(s)` +
        (socialSummary.junkCount > 0 ? ` (${socialSummary.junkCount} junk dropped)` : "") +
        `, ${officials.length} official, ${qualifyingRealtime.length} realtime -> ` +
        `${confidence.value.toFixed(3)} ${confidence.band}`,
      data: {
        [VERIFY_HOP_DATA_KEY]: evidenceSummary,
        issueVoteTally: vote.tally,
        ingestConfidence: ingestScore.value,
        locationReasons: shape.resolution === "RESOLVED" ? [] : evaluated.flatMap((e) => e.resolution.reasons),
        ambiguity: evaluated.find((e) => e.resolution.ambiguity)?.resolution.ambiguity ?? null,
      },
    };

    const signal: DisruptionSignal = {
      id: signalIdFor([
        issueType,
        signalIdentityKey({
          issueType,
          segmentIds: shape.segmentIds,
          lineIds: shape.lineIds,
          stationIds: shape.stationIds,
        }),
        windowStartsAt,
      ]),
      createdAt: input.now,
      updatedAt: input.now,
      status,
      segmentIds: shape.segmentIds,
      stationIds: shape.stationIds,
      lineIds: shape.lineIds,
      resolution: shape.resolution,
      ...(shape.resolution === "UNRESOLVED"
        ? { unresolvedCandidates: shape.unresolvedCandidates }
        : {}),
      issueType,
      severity,
      confidence,
      firstSeenAt,
      lastSeenAt,
      operatorNotifiedAt,
      leadTimeMinutes: leadTimeMinutes(firstSeenAt, operatorNotifiedAt),
      corroboratingSources: {
        official: officials.length,
        socialDistinctAuthors: socialSummary.authors.length,
        realtimeObservations: qualifyingRealtime.length,
      },
      sources,
      reasoning: buildReasoning({
        issueType,
        shape,
        socialAuthors: socialSummary.authors.length,
        officialCount: officials.length,
        realtimeCount: qualifyingRealtime.length,
        junkCount: socialSummary.junkCount,
        value: confidence.value,
        band: confidence.band,
        windowMinutes,
        extra: reasoningSuffix({
          officialCount: officials.length,
          officialDenial,
          unresolved: shape.resolution === "UNRESOLVED",
          socialAuthors: socialSummary.authors.length,
          junkCount: socialSummary.junkCount,
        }),
      }),
      wouldAHumanCheckThis: confidence.value < 0.65 || shape.resolution === "UNRESOLVED",
      window: {
        startsAt: windowStartsAt,
        endsAt: recovery ? input.now : null,
      },
      provenance: [ingestHop, verifyHop],
    };

    signals.push(signal);
  }

  return {
    signals,
    rejected,
    candidates,
    hops: signals.flatMap((s) => s.provenance),
  };
}

/** Convenience wrapper for the replay chain (A3). */
export function runSignalPipeline(input: VerifyAgentInput): DisruptionSignal[] {
  return runVerifyAgent(input).signals;
}

/** Run a committed corpus scenario by id, using the scenario's pinned `now`. */
export function signalsForScenario(scenarioId: string): {
  signals: DisruptionSignal[];
  result: VerificationResult;
  scenario: CorpusScenario;
} {
  const scenario = loadScenario(scenarioId);
  const records = scenarioRecords(scenarioId);
  const result = runVerifyAgent({ records, now: scenario.now });
  return { signals: result.signals, result, scenario };
}

/**
 * CUSTOM TOOL — station/line entity resolver, exposed as an inspectable tool.
 *
 * Why this cannot come from a template: it knows the actual 187-station Klang
 * Valley network and its dialects — Malay and English names, real colloquialisms
 * (TTDI, TRX, HKL, BTS), the feed's own ` - UOB` decorations, the fact that
 * `KJ13`/`SP7`/`AG7` are ONE place (Masjid Jamek) while "Klang" is THREE
 * different places, and that `MRT` in stops.txt means the canonical line `KGL`.
 * A generic string search cannot refuse to choose; this one can.
 */

import { aliasIndex, networkIndex } from "@/lib/signals";
import {
  type LocationResolution,
  type StationMatch,
  matchStationText,
  resolveLocation,
} from "@/lib/signals/entity-resolver";
import { defineTool } from "@/lib/signals/tool";

export interface StationResolverInput {
  /** Full claim text, e.g. "Tren berhenti antara KLCC dan Ampang Park". */
  text: string;
  /** Station mentions the phrase parser already extracted (STESEN ...). */
  extraStationMentions?: string[];
  /** Line mentions the phrase parser already extracted (LALUAN ...). */
  extraLineMentions?: string[];
}

export function resolveStationEntities(input: StationResolverInput): LocationResolution {
  return resolveLocation(input.text, networkIndex(), aliasIndex(), {
    extraStationMentions: input.extraStationMentions,
    extraLineMentions: input.extraLineMentions,
  });
}

export function matchStationMention(mention: string): StationMatch {
  return matchStationText(mention, aliasIndex());
}

export const stationEntityResolverTool = defineTool<StationResolverInput, LocationResolution>({
  name: "resolve_station_entities",
  description:
    "Map a claimed station, line or inter-station phrase onto canonical segment ids, " +
    "or return UNRESOLVED with every candidate segment listed.",
  provenance:
    "Built against the real 187-station GTFS list with Malay/English variants, " +
    "colloquial abbreviations, typo tolerance and interchange collapsing " +
    "(KJ13/SP7/AG7 are one place; 'Klang' is three). It is the only component " +
    "allowed to decide that a location is ambiguous, and it refuses to choose.",
  run: resolveStationEntities,
});

export const stationMentionMatcherTool = defineTool<{ mention: string }, StationMatch>({
  name: "match_station_mention",
  description:
    "Match a single station mention (including misspellings and abbreviations) to " +
    "station ids and physical places.",
  provenance:
    "Handles the feed's trailing spaces and ' - UOB' decorations, USJ 7/USJ7 style " +
    "spacing differences, Malay/English name pairs, and Damerau-Levenshtein typos " +
    "with a length-scaled budget. Reports every match rather than the best one.",
  run: (input) => matchStationMention(input.mention),
});

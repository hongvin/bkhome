/**
 * The verify agent's custom tool registry.
 *
 * The Verifier's domain knowledge is the Klang Valley network itself: which
 * platform ids are one physical place, which names are genuinely ambiguous, and
 * which line id dialect each GTFS file uses. See `station-tool.ts`.
 */

import type { AgentTool } from "@/lib/signals/tool";
import type { LocationResolution, StationMatch } from "@/lib/signals/entity-resolver";

import {
  type StationResolverInput,
  stationEntityResolverTool,
  stationMentionMatcherTool,
} from "./station-tool";

export const VERIFY_TOOLS: ReadonlyArray<
  AgentTool<StationResolverInput, LocationResolution> | AgentTool<{ mention: string }, StationMatch>
> = [stationEntityResolverTool, stationMentionMatcherTool];

export function verifyToolNames(): string[] {
  return VERIFY_TOOLS.map((t) => t.name);
}

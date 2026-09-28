/**
 * Ground-transport fallback estimate.
 *
 * When every rail candidate crosses a segment above the avoid threshold, the
 * product must not leave the rider with nothing. It must say, explicitly, that
 * there is no safe rail option and give a realistic road alternative with its own
 * number.
 *
 * The estimate is deliberately simple and fully stated, because a made-up precise
 * number would be worse than an honest range:
 *
 *   roadKm      = great-circle origin->destination (or rail distance when
 *                 coordinates are unavailable) x ROAD_DETOUR_FACTOR
 *   roadSeconds = roadKm / ROAD_SPEED_KMH[traffic regime] + HAIL_WAIT_SECONDS
 *
 * Grounding:
 *   - RAIL_AVG_SPEED_KMH = 34.6 is MEASURED from the committed GTFS: 1546.6 km
 *     of `shapes.txt` polyline over 44.7 hours of scheduled running across all
 *     48 trip templates. It converts a known rail journey time into an implied
 *     rail distance when the caller has no coordinates.
 *   - ROAD_DETOUR_FACTOR = 1.35 is the standard road-network circuity factor for
 *     a dense Asian city (roads are never straight lines between two points).
 *   - The two road speeds reflect Klang Valley reality: ~32 km/h on an open
 *     road, ~22 km/h in the 07:00-09:30 and 17:00-19:30 peaks, plus a 5-minute
 *     hail wait. Rain or an incident can halve the speed again, which the note
 *     says out loud rather than hiding inside the point estimate.
 */

import type { GroundTransportFallback, LatLng, StationId } from "@/lib/contracts";
import { isPeakWindow } from "./penalty";
import { haversineMeters } from "./interchange";

/** Measured from the committed GTFS feed (shapes + stop_times). */
export const RAIL_AVG_SPEED_KMH = 34.6;
/** Road network circuity: real roads are longer than the straight line. */
export const ROAD_DETOUR_FACTOR = 1.35;
export const ROAD_SPEED_KMH_OFFPEAK = 32;
export const ROAD_SPEED_KMH_PEAK = 22;
/** Time to hail a car and get in, seconds. */
export const HAIL_WAIT_SECONDS = 300;
/** The gap between the "no safe rail option" message and a rail option opening. */
export const NO_SAFE_RAIL_LEAD_IN =
  "No rail itinerary avoids every segment above the 70% confidence threshold";

export interface GroundTransportInput {
  originStationId: StationId;
  destinationStationId: StationId;
  /** Deterministic rail journey time, seconds. Used to infer distance if no coords. */
  railScheduledSeconds: number;
  origin?: LatLng;
  destination?: LatLng;
  /** Local seconds after midnight; selects the traffic regime. */
  atTime?: number;
}

function roundTo(value: number, step: number): number {
  return Math.round(value / step) * step;
}

export function estimateGroundTransportFallback(
  input: GroundTransportInput,
): GroundTransportFallback {
  let straightLineKm: number;
  let distanceBasis: string;

  if (input.origin && input.destination) {
    const meters = haversineMeters(input.origin, input.destination);
    straightLineKm = meters / 1000;
    distanceBasis = `${straightLineKm.toFixed(1)} km straight line`;
  } else {
    const railKm = (Math.max(0, input.railScheduledSeconds) / 3600) * RAIL_AVG_SPEED_KMH;
    straightLineKm = railKm;
    distanceBasis = `${railKm.toFixed(1)} km inferred from the ${Math.round(
      input.railScheduledSeconds / 60,
    )}-minute rail time at ${RAIL_AVG_SPEED_KMH} km/h`;
  }

  const roadKm = straightLineKm * ROAD_DETOUR_FACTOR;
  const peak = input.atTime !== undefined && isPeakWindow(input.atTime);
  const speed = peak ? ROAD_SPEED_KMH_PEAK : ROAD_SPEED_KMH_OFFPEAK;
  const driveSeconds = (roadKm / speed) * 3600;
  const estimatedDurationSeconds = roundTo(driveSeconds + HAIL_WAIT_SECONDS, 60);

  return {
    description:
      `Grab or metered taxi, ${input.originStationId} to ${input.destinationStationId} ` +
      `(~${roadKm.toFixed(1)} km by road)`,
    estimatedDurationSeconds,
    note:
      `${NO_SAFE_RAIL_LEAD_IN}. Estimate assumes ${roadKm.toFixed(1)} km of road ` +
      `(${distanceBasis}, x${ROAD_DETOUR_FACTOR} circuity) at ${speed} km/h ` +
      `${peak ? "in the peak" : "off-peak"} plus a ${HAIL_WAIT_SECONDS / 60}-minute hail wait. ` +
      `Klang Valley road speed varies by +/-40% with rain and incidents, so treat this as a floor, not a promise.`,
  };
}

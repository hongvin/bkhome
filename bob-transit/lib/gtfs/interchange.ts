/**
 * Interchange (transfer) modelling.
 *
 * In this feed an interchange is NOT a shared `stop_id`: Masjid Jamek is
 * `KJ13` + `AG7` + `SP7`, Ampang Park is `KJ9` + `PY20`, Hang Tuah is
 * `AG9` + `SP9` + `MR4`. The frozen `Station` contract has no transfer field,
 * so the router derives footpaths from the stations themselves:
 *
 *   1. two stops with the same punctuation-insensitive name, or
 *   2. two stops on DIFFERENT lines within INTERCHANGE_MAX_WALK_METERS.
 *
 * Rule 2 is needed because the feed's names are not always equal for a real
 * interchange: KL Sentral is `KJ15` "KL SENTRAL - REDONE" and `MR1`
 * "KL SENTRAL", 246 m apart. Rule 2 also produces two deliberate
 * over-connections that are physically walkable and therefore harmless:
 * Ampang Park `KJ9` <-> Persiaran KLCC `PY21` (294 m) and KL Sentral `KJ15`
 * <-> Muzium Negara `KG15` (344 m).
 */

import type { Station, StationId } from "@/lib/contracts";
import { canonicalNameKey } from "./normalize";
import { haversineMeters } from "./geo";

/** Maximum station-to-station walk treated as an interchange. */
export const INTERCHANGE_MAX_WALK_METERS = 350;

/** Fixed overhead of leaving one paid area and entering another, in seconds. */
export const TRANSFER_BASE_SECONDS = 120;

/** Cap so a mis-detected link cannot dominate a journey. */
export const TRANSFER_MAX_SECONDS = 900;

/** Average walking speed inside a station complex. */
export const WALK_SPEED_MPS = 1.2;

export interface InterchangeLink {
  fromStationId: StationId;
  toStationId: StationId;
  distanceMeters: number;
  walkSeconds: number;
}

export interface InterchangeGroup {
  key: string;
  name: string;
  stationIds: StationId[];
}

export interface InterchangeTopology {
  groups: InterchangeGroup[];
  /** Directed footpaths, symmetric in practice. */
  linksByStation: Map<StationId, InterchangeLink[]>;
  /** groupId per station, for tests and debugging. */
  groupKeyByStation: Map<StationId, string>;
}

/** Walking time for a transfer, including the paid-area overhead. */
export function transferWalkSeconds(distanceMeters: number): number {
  const raw = TRANSFER_BASE_SECONDS + distanceMeters / WALK_SPEED_MPS;
  return Math.min(TRANSFER_MAX_SECONDS, Math.max(TRANSFER_BASE_SECONDS, Math.round(raw)));
}

function shareLine(a: Station, b: Station): boolean {
  return a.lineIds.some((line) => b.lineIds.includes(line));
}

export function computeInterchanges(stations: Station[]): InterchangeTopology {
  const parent = new Map<StationId, StationId>();
  const find = (id: StationId): StationId => {
    let root = id;
    while (parent.get(root) !== undefined && parent.get(root) !== root) {
      root = parent.get(root) as StationId;
    }
    // Path compression.
    let cursor = id;
    while (cursor !== root) {
      const next = parent.get(cursor) as StationId;
      parent.set(cursor, root);
      cursor = next;
    }
    return root;
  };
  const union = (a: StationId, b: StationId): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(rb, ra);
  };

  for (const s of stations) parent.set(s.id, s.id);

  const linksByStation = new Map<StationId, InterchangeLink[]>();
  const addLink = (a: Station, b: Station, distanceMeters: number): void => {
    const walkSeconds = transferWalkSeconds(distanceMeters);
    const ab: InterchangeLink = {
      fromStationId: a.id,
      toStationId: b.id,
      distanceMeters,
      walkSeconds,
    };
    const ba: InterchangeLink = {
      fromStationId: b.id,
      toStationId: a.id,
      distanceMeters,
      walkSeconds,
    };
    const listA = linksByStation.get(a.id);
    if (listA) listA.push(ab);
    else linksByStation.set(a.id, [ab]);
    const listB = linksByStation.get(b.id);
    if (listB) listB.push(ba);
    else linksByStation.set(b.id, [ba]);
    union(a.id, b.id);
  };

  for (let i = 0; i < stations.length; i += 1) {
    for (let j = i + 1; j < stations.length; j += 1) {
      const a = stations[i];
      const b = stations[j];
      if (a.id === b.id) continue;
      const sameName =
        canonicalNameKey(a.name) !== "" && canonicalNameKey(a.name) === canonicalNameKey(b.name);
      if (sameName) {
        addLink(a, b, haversineMeters(a, b));
        continue;
      }
      if (shareLine(a, b)) continue;
      const distance = haversineMeters(a, b);
      if (distance <= INTERCHANGE_MAX_WALK_METERS) addLink(a, b, distance);
    }
  }

  // Deterministic link order (closest first, then by id) so routing is stable.
  for (const list of linksByStation.values()) {
    list.sort(
      (x, y) =>
        x.distanceMeters - y.distanceMeters || x.toStationId.localeCompare(y.toStationId),
    );
  }

  const membersByRoot = new Map<StationId, StationId[]>();
  for (const s of stations) {
    const root = find(s.id);
    const list = membersByRoot.get(root);
    if (list) list.push(s.id);
    else membersByRoot.set(root, [s.id]);
  }

  const stationById = new Map(stations.map((s) => [s.id, s] as const));
  const groups: InterchangeGroup[] = [];
  const groupKeyByStation = new Map<StationId, string>();
  for (const [, memberIds] of membersByRoot) {
    const sorted = [...memberIds].sort((a, b) => a.localeCompare(b));
    const key = sorted.join("+");
    for (const id of sorted) groupKeyByStation.set(id, key);
    if (sorted.length < 2) continue;
    const first = stationById.get(sorted[0]);
    groups.push({
      key,
      name: first ? first.name : sorted[0],
      stationIds: sorted,
    });
  }
  groups.sort((a, b) => a.key.localeCompare(b.key));

  return { groups, linksByStation, groupKeyByStation };
}

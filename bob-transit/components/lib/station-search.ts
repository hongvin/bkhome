/**
 * Station search — pure ranking function, unit-testable without a DOM.
 */
import type { Line, Station } from "@/lib/contracts";

export interface StationMatch {
  station: Station;
  /** Lower is better. */
  score: number;
}

const MAX_RESULTS = 40;

/**
 * Rank stations against a free-text query.
 *
 * Exact code match > name prefix > word prefix > substring > line short-name
 * match. Interchanges win ties because they are the useful destinations.
 */
export function searchStations(
  stations: readonly Station[],
  lines: readonly Line[],
  query: string,
  limit = MAX_RESULTS,
): Station[] {
  const q = query.trim().toLowerCase();
  if (q === "") {
    return [...stations]
      .sort(
        (a, b) =>
          Number(b.isInterchange) - Number(a.isInterchange) || a.name.localeCompare(b.name),
      )
      .slice(0, limit);
  }

  const lineById = new Map(lines.map((l) => [l.id, l]));
  const matches: StationMatch[] = [];

  for (const station of stations) {
    const name = station.name.toLowerCase();
    const nameMs = station.nameMs.toLowerCase();
    const id = station.id.toLowerCase();
    let score = Number.POSITIVE_INFINITY;

    if (id === q) score = 0;
    else if (name === q || nameMs === q) score = 1;
    else if (name.startsWith(q) || nameMs.startsWith(q)) score = 2;
    else if (name.split(/\s+/).some((word) => word.startsWith(q))) score = 3;
    else if (name.includes(q) || nameMs.includes(q)) score = 4;
    else {
      const lineHit = station.lineIds.some((lineId) => {
        const line = lineById.get(lineId);
        if (!line) return false;
        return (
          line.shortName.toLowerCase() === q ||
          line.longName.toLowerCase().includes(q) ||
          line.longNameMs.toLowerCase().includes(q)
        );
      });
      if (lineHit) score = 5;
    }

    if (Number.isFinite(score)) {
      matches.push({ station, score: score - (station.isInterchange ? 0.5 : 0) });
    }
  }

  matches.sort(
    (a, b) => a.score - b.score || a.station.name.localeCompare(b.station.name),
  );
  return matches.slice(0, limit).map((match) => match.station);
}

/** Small set of one-tap trips so the demo is usable without typing. */
export const POPULAR_TRIPS: Array<{ origin: string; destination: string }> = [
  { origin: "KJ15", destination: "KG35" },
  { origin: "KJ10", destination: "KG35" },
  { origin: "KJ1", destination: "KJ37" },
  { origin: "AG18", destination: "SP31" },
  { origin: "KJ15", destination: "PY41" },
  { origin: "KG04", destination: "KG35" },
];

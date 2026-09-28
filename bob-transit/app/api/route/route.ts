/**
 * GET /api/route?origin=KJ15&destination=KG35&mode=cache
 *
 * Returns a `RouteAdvisory`: ranked-by-reliability itineraries, the P90 arrival
 * window, the recommended itinerary, and the fragility note.
 *
 * POST accepts a full `RouteQuery` body for callers that need to pin
 * `departAfterSeconds` / `serviceWeekday`.
 */
import { NextResponse } from "next/server";

import type { ApiResponse, PlanRouteResponse, RouteQuery } from "@/lib/contracts";
import {
  buildRouteQuery,
  dataSource,
  DEFAULT_DESTINATION_STATION_ID,
  DEFAULT_ORIGIN_STATION_ID,
} from "@/lib/mock";

import { parseInteger, parseMode, parseString } from "@/app/api/_lib/params";

export const dynamic = "force-dynamic";

function errorResponse(
  code: "BAD_REQUEST" | "NOT_FOUND",
  message: string,
  messageKey: string,
  mode: "cache" | "live",
): NextResponse<ApiResponse<never>> {
  return NextResponse.json(
    { ok: false as const, error: { code, message, messageKey }, meta: dataSource.apiMeta(mode) },
    { status: code === "BAD_REQUEST" ? 400 : 404 },
  );
}

export function GET(request: Request): NextResponse<ApiResponse<PlanRouteResponse>> {
  const url = new URL(request.url);
  const mode = parseMode(url);
  const origin = parseString(url, "origin") ?? DEFAULT_ORIGIN_STATION_ID;
  const destination = parseString(url, "destination") ?? DEFAULT_DESTINATION_STATION_ID;

  const network = dataSource.getNetwork();
  const ids = new Set(network.stations.map((s) => s.id));
  if (!ids.has(origin)) {
    return errorResponse("NOT_FOUND", `Unknown origin station ${origin}`, "results.empty", mode);
  }
  if (!ids.has(destination)) {
    return errorResponse(
      "NOT_FOUND",
      `Unknown destination station ${destination}`,
      "results.empty",
      mode,
    );
  }

  const base = buildRouteQuery(origin, destination);
  const query: RouteQuery = {
    ...base,
    maxItineraries: parseInteger(url, "maxItineraries", base.maxItineraries, 1, 5),
    maxTransfers: parseInteger(url, "maxTransfers", base.maxTransfers, 0, 4),
  };

  const advisory = dataSource.planRoute(query, mode);
  return NextResponse.json({
    ok: true,
    data: { advisory },
    meta: dataSource.apiMeta(mode),
  });
}

export async function POST(
  request: Request,
): Promise<NextResponse<ApiResponse<PlanRouteResponse>>> {
  const url = new URL(request.url);
  const mode = parseMode(url);

  let body: Partial<RouteQuery>;
  try {
    body = (await request.json()) as Partial<RouteQuery>;
  } catch {
    return errorResponse("BAD_REQUEST", "Body must be JSON", "common.error", mode);
  }

  const origin = body.originStationId ?? DEFAULT_ORIGIN_STATION_ID;
  const destination = body.destinationStationId ?? DEFAULT_DESTINATION_STATION_ID;
  const base = buildRouteQuery(origin, destination);

  const query: RouteQuery = {
    ...base,
    departAfterSeconds:
      typeof body.departAfterSeconds === "number"
        ? body.departAfterSeconds
        : base.departAfterSeconds,
    serviceWeekday:
      typeof body.serviceWeekday === "number" ? body.serviceWeekday : base.serviceWeekday,
    maxItineraries:
      typeof body.maxItineraries === "number"
        ? Math.min(5, Math.max(1, body.maxItineraries))
        : base.maxItineraries,
    maxInitialWaitSeconds:
      typeof body.maxInitialWaitSeconds === "number"
        ? body.maxInitialWaitSeconds
        : base.maxInitialWaitSeconds,
    maxTransfers:
      typeof body.maxTransfers === "number"
        ? Math.min(4, Math.max(0, body.maxTransfers))
        : base.maxTransfers,
  };

  const advisory = dataSource.planRoute(query, mode);
  return NextResponse.json({
    ok: true,
    data: { advisory },
    meta: dataSource.apiMeta(mode),
  });
}

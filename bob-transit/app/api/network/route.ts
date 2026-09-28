/**
 * GET /api/network
 *
 * The topology the map draws and the station picker searches. Served from the
 * data-source seam so the UI never reads files or imports the mock directly.
 */
import { NextResponse } from "next/server";

import type { ApiResponse } from "@/lib/contracts";
import { dataSource } from "@/lib/mock";
import { parseMode } from "@/app/api/_lib/params";

export const dynamic = "force-static";

export interface NetworkResponse {
  lines: ReturnType<typeof dataSource.getNetwork>["lines"];
  stations: ReturnType<typeof dataSource.getNetwork>["stations"];
  segments: ReturnType<typeof dataSource.getNetwork>["segments"];
  source: ReturnType<typeof dataSource.meta>;
  defaultOriginStationId: string;
  defaultDestinationStationId: string;
}

export function GET(request: Request): NextResponse<ApiResponse<NetworkResponse>> {
  const mode = parseMode(new URL(request.url));
  const network = dataSource.getNetwork();
  return NextResponse.json({
    ok: true,
    data: {
      ...network,
      source: dataSource.meta(),
      defaultOriginStationId: "KJ15",
      defaultDestinationStationId: "KG35",
    },
    meta: dataSource.apiMeta(mode),
  });
}

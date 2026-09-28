/**
 * GET /api/risk
 *
 * The network risk overlay. Carries `asOf` + `stalenessMinutes` + `isStale` so
 * the client can always render "as of HH:MM, N min ago" and never present a
 * cached overlay as live.
 */
import { NextResponse } from "next/server";

import type { ApiResponse, RiskOverlayResponse } from "@/lib/contracts";
import { dataSource } from "@/lib/mock";

import { parseMode } from "@/app/api/_lib/params";

export const dynamic = "force-dynamic";

export function GET(request: Request): NextResponse<ApiResponse<RiskOverlayResponse>> {
  const mode = parseMode(new URL(request.url));
  return NextResponse.json({
    ok: true,
    data: { overlay: dataSource.getOverlay(mode) },
    meta: dataSource.apiMeta(mode),
  });
}

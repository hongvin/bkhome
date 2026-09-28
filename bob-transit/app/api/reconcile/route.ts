/**
 * GET /api/reconcile?since=<ISO>
 *
 * What a device calls when it comes back from a tunnel: which signals changed,
 * which cleared, which are new, and the fresh overlay. The client merges rather
 * than refetching everything.
 */
import { NextResponse } from "next/server";

import type { ApiResponse, ReconcileResponse } from "@/lib/contracts";
import { dataSource } from "@/lib/mock";

import { parseMode, parseString } from "@/app/api/_lib/params";

export const dynamic = "force-dynamic";

export function GET(request: Request): NextResponse<ApiResponse<ReconcileResponse>> {
  const url = new URL(request.url);
  const mode = parseMode(url);
  const since = parseString(url, "since") ?? new Date(0).toISOString();

  return NextResponse.json({
    ok: true,
    data: dataSource.reconcile(since),
    meta: dataSource.apiMeta(mode),
  });
}

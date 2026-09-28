/**
 * GET /api/signals?since=<ISO>
 *
 * Active disruption signals. When `since` is supplied the response also carries
 * `changedSince`, which is the reconnect path for a device that has been in a
 * tunnel and comes back with stale state.
 */
import { NextResponse } from "next/server";

import type { ApiResponse, SignalsResponse } from "@/lib/contracts";
import { dataSource } from "@/lib/mock";

import { parseMode, parseString } from "@/app/api/_lib/params";

export const dynamic = "force-dynamic";

export function GET(request: Request): NextResponse<ApiResponse<SignalsResponse>> {
  const url = new URL(request.url);
  const mode = parseMode(url);
  const since = parseString(url, "since");
  const signals = dataSource.getSignals();

  const payload: SignalsResponse = { signals };
  if (since) {
    const sinceMs = Date.parse(since);
    if (Number.isFinite(sinceMs)) {
      payload.changedSince = signals.filter((s) => Date.parse(s.updatedAt) > sinceMs);
    }
  }

  return NextResponse.json({
    ok: true,
    data: payload,
    meta: dataSource.apiMeta(mode),
  });
}

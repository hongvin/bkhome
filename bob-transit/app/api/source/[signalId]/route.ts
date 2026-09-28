/**
 * GET /api/source/:signalId
 *
 * Screen E's data: the plain-language trace from signal -> segment ->
 * confidence -> route decision, with confidence at every pipeline hop.
 */
import { NextResponse } from "next/server";

import type { ApiResponse, SourceInspectorResponse } from "@/lib/contracts";
import { dataSource } from "@/lib/mock";

import { parseMode } from "@/app/api/_lib/params";

export const dynamic = "force-dynamic";

export function GET(
  request: Request,
  context: { params: Promise<{ signalId: string }> },
): Promise<NextResponse<ApiResponse<SourceInspectorResponse>>> {
  const mode = parseMode(new URL(request.url));
  return context.params.then(({ signalId }) => {
    const trace = dataSource.getSourceTrace(decodeURIComponent(signalId));
    if (!trace) {
      return NextResponse.json(
        {
          ok: false as const,
          error: {
            code: "NOT_FOUND" as const,
            message: `No source trace for signal ${signalId}`,
            messageKey: "source.noTrace",
          },
          meta: dataSource.apiMeta(mode),
        },
        { status: 404 },
      );
    }
    return NextResponse.json({
      ok: true,
      data: { trace },
      meta: dataSource.apiMeta(mode),
    });
  });
}

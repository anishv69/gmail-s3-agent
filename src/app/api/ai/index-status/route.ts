import { NextRequest, NextResponse } from "next/server";
import { getAiIndexProgress } from "@/lib/ai/indexing";
import { hasDashboardAuthorization } from "@/lib/dashboard-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  if (!hasDashboardAuthorization(request)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  try {
    return NextResponse.json(await getAiIndexProgress(), {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    console.error("[ai-index] status_failed", {
      errorType: error instanceof Error ? error.name : "UnknownError",
    });
    return NextResponse.json(
      { error: "Unable to read AI indexing status." },
      { status: 503 },
    );
  }
}

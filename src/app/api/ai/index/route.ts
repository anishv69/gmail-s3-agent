import { NextRequest, NextResponse } from "next/server";
import { runAiIndexBatch, startAiIndexing, withAiIndexLock } from "@/lib/ai/indexing";
import { hasDashboardAuthorization } from "@/lib/dashboard-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: NextRequest) {
  if (!hasDashboardAuthorization(request)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  if (!process.env.OPENAI_API_KEY?.trim()) {
    return NextResponse.json(
      { error: "Document indexing is disabled until OPENAI_API_KEY is configured." },
      { status: 503 },
    );
  }
  if (process.env.NODE_ENV === "production" && !process.env.DIRECT_URL?.trim()) {
    return NextResponse.json(
      { error: "AI indexing requires DIRECT_URL for its PostgreSQL advisory lock." },
      { status: 503 },
    );
  }

  try {
    const body: unknown = await request.json();
    const action =
      body && typeof body === "object" && "action" in body
        ? (body as { action?: unknown }).action
        : undefined;
    if (action !== "start" && action !== "batch") {
      return NextResponse.json(
        { error: "Action must be either start or batch." },
        { status: 400 },
      );
    }
    const requestedLimit =
      body && typeof body === "object" && "limit" in body
        ? (body as { limit?: unknown }).limit
        : undefined;
    if (
      requestedLimit !== undefined &&
      (!Number.isSafeInteger(requestedLimit) || Number(requestedLimit) < 1)
    ) {
      return NextResponse.json({ error: "limit must be a positive integer." }, { status: 400 });
    }

    const locked = await withAiIndexLock(async () =>
      action === "start" ? startAiIndexing() : runAiIndexBatch(Number(requestedLimit)),
    );
    if (!locked.acquired) {
      return NextResponse.json(
        { error: "An AI indexing batch is already running." },
        { status: 409 },
      );
    }
    return NextResponse.json(locked.result, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    const errorType = error instanceof Error ? error.name : "UnknownError";
    const message = error instanceof Error ? error.message : "";
    console.error("[ai-index] batch_failed", {
      errorType,
      category: /DIRECT_URL/.test(message) ? "database_configuration" : "index_batch_failed",
    });
    return NextResponse.json(
      {
        error: /DIRECT_URL/.test(message)
          ? "Configure DIRECT_URL with the Neon direct connection string."
          : "Unable to run the AI index batch. Check safe server diagnostics.",
      },
      { status: 502 },
    );
  }
}

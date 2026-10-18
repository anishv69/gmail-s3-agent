import { NextRequest, NextResponse } from "next/server";
import { syncRecentInboxBatch } from "@/lib/gmail-sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json(
      { error: "The sync endpoint is not configured (missing CRON_SECRET)." },
      { status: 503 },
    );
  }

  if (request.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  try {
    const summary = await syncRecentInboxBatch();
    return NextResponse.json({
      ok: true,
      batchLimit: 5,
      checkpointAdvanced: false,
      ...summary,
    });
  } catch (error) {
    const errorType =
      error instanceof Error ? error.name : "UnknownError";
    console.error("Recent Gmail sample sync failed:", { errorType });
    return NextResponse.json(
      {
        error:
          "Recent Gmail sample sync failed. Check server configuration and service logs.",
      },
      { status: 500 },
    );
  }
}

import { NextRequest, NextResponse } from "next/server";
import { hasDashboardAuthorization } from "@/lib/dashboard-auth";
import {
  getHistoricalSyncState,
  getSafeSyncDiagnostic,
  restartHistoricalSync,
  syncHistoricalBatch,
} from "@/lib/gmail-sync";
import { withGmailSchedulerLock } from "@/lib/scheduler-lock";

export const runtime = "nodejs";

function publicStatus(state: Awaited<ReturnType<typeof getHistoricalSyncState>>) {
  return {
    status: state.status,
    processedMessages: state.processedMessages,
    skippedMessages: state.skippedMessages,
    uploadedAttachments: state.uploadedAttachments,
  };
}

export async function GET(request: NextRequest) {
  if (!hasDashboardAuthorization(request)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  try {
    return NextResponse.json(publicStatus(await getHistoricalSyncState()));
  } catch (error) {
    console.error("[gmail-history] status_failed", getSafeSyncDiagnostic(error));
    return NextResponse.json({ error: "Unable to read history sync status." }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  if (!hasDashboardAuthorization(request)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const restart = request.nextUrl.searchParams.get("restart") === "true";
  try {
    const cycle = await withGmailSchedulerLock(async () => {
      if (restart) {
        await restartHistoricalSync();
      }
      return syncHistoricalBatch();
    });
    if (!cycle.acquired) {
      return NextResponse.json(
        { error: "A Gmail synchronization cycle is already running." },
        { status: 409 },
      );
    }
    console.info("[gmail-history] batch_succeeded", {
      restart,
      status: cycle.result.status,
      processedMessages: cycle.result.processedMessages,
      skippedMessages: cycle.result.skippedMessages,
      uploadedAttachments: cycle.result.uploadedAttachments,
    });
    return NextResponse.json(publicStatus(cycle.result));
  } catch (error) {
    const diagnostic = getSafeSyncDiagnostic(error);
    console.error("[gmail-history] batch_failed", diagnostic);
    return NextResponse.json(
      { error: "Historical sync batch failed.", diagnostic },
      { status: 500 },
    );
  }
}

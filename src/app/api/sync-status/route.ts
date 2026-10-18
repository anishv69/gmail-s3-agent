import { NextRequest, NextResponse } from "next/server";
import { hasDashboardAuthorization } from "@/lib/dashboard-auth";
import { getGmailSyncStatus, getSafeSyncDiagnostic } from "@/lib/gmail-sync";
import { getGmailSchedulerState } from "@/lib/gmail-scheduler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  if (!hasDashboardAuthorization(request)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  try {
    const scheduler = getGmailSchedulerState();
    return NextResponse.json({
      ...await getGmailSyncStatus(),
      schedulerEnabled: scheduler.enabled,
      intervalMs: scheduler.intervalMs,
      nextScheduledAt: scheduler.nextRunAt,
      schedulerSyncing: scheduler.syncing,
    });
  } catch (error) {
    console.error("[gmail-sync] status_read_failed", getSafeSyncDiagnostic(error));
    return NextResponse.json(
      { error: "Unable to read Gmail synchronization status." },
      { status: 503 },
    );
  }
}

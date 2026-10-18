import { NextRequest, NextResponse } from "next/server";
import {
  getCurrentPollProgress,
  getSafeSyncDiagnostic,
  pollInbox,
} from "@/lib/gmail-sync";
import { withGmailSchedulerLock } from "@/lib/scheduler-lock";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json(
      { error: "The cron endpoint is not configured (missing CRON_SECRET)." },
      { status: 503 },
    );
  }

  if (request.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const startedAt = new Date();
  const startedAtMs = Date.now();
  console.info("[gmail-sync] manual_cycle_started", {
    startedAt: startedAt.toISOString(),
  });

  try {
    const cycle = await withGmailSchedulerLock(pollInbox);
    if (!cycle.acquired) {
      console.info("[gmail-sync] manual_cycle_skipped", {
        startedAt: startedAt.toISOString(),
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAtMs,
        reason: "scheduler_lock_held_elsewhere",
      });
      return NextResponse.json(
        { ok: false, error: "A Gmail synchronization cycle is already running." },
        { status: 409 },
      );
    }

    console.info("[gmail-sync] manual_cycle_succeeded", {
      startedAt: startedAt.toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAtMs,
      newMessages: cycle.result.processedMessages,
      skippedDuplicates: cycle.result.skippedMessages,
      ...cycle.result,
    });
    return NextResponse.json({ ok: true, ...cycle.result });
  } catch (error) {
    const diagnostic = getSafeSyncDiagnostic(error);
    console.error("[gmail-sync] manual_cycle_failed", {
      startedAt: startedAt.toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAtMs,
      newMessages: getCurrentPollProgress().processedMessages,
      skippedDuplicates: getCurrentPollProgress().skippedMessages,
      ...diagnostic,
    });
    return NextResponse.json(
      {
        error: "Gmail inbox polling failed. Check the safe diagnostic in server logs.",
        diagnostic,
      },
      { status: 500 },
    );
  }
}

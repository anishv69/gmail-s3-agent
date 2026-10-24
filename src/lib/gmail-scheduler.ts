import {
  getCurrentPollProgress,
  getSafeSyncDiagnostic,
  pollInbox,
} from "@/lib/gmail-sync";
import { withGmailSchedulerLock } from "@/lib/scheduler-lock";

const DEFAULT_INTERVAL_MS = 60 * 1000;

type SchedulerGlobal = typeof globalThis & {
  gmailSyncScheduler?: NodeJS.Timeout;
  gmailSyncIntervalMs?: number;
  gmailSyncNextRunAt?: string | null;
  gmailSyncSchedulerBusy?: boolean;
};

const schedulerGlobal = globalThis as SchedulerGlobal;

function usesPlatformScheduler(): boolean {
  return (
    process.env.VERCEL === "1" &&
    process.env.GMAIL_SYNC_ENABLED === "true"
  );
}

export function getGmailSchedulerState(): {
  enabled: boolean;
  intervalMs: number;
  nextRunAt: string | null;
  syncing: boolean;
} {
  return {
    enabled: Boolean(schedulerGlobal.gmailSyncScheduler) || usesPlatformScheduler(),
    intervalMs: schedulerGlobal.gmailSyncIntervalMs ?? getPollIntervalMs(),
    nextRunAt: schedulerGlobal.gmailSyncNextRunAt ?? null,
    syncing: schedulerGlobal.gmailSyncSchedulerBusy === true,
  };
}

function getPollIntervalMs(): number {
  const configuredInterval = process.env.GMAIL_SYNC_INTERVAL_MS;
  if (!configuredInterval) {
    return DEFAULT_INTERVAL_MS;
  }

  const interval = Number(configuredInterval);
  if (!Number.isInteger(interval) || interval < 1000) {
    throw new Error("GMAIL_SYNC_INTERVAL_MS must be an integer of at least 1000");
  }
  return interval;
}

function missingConfiguration(): string[] {
  return [
    "DATABASE_URL",
    "GMAIL_USER_EMAIL",
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
    "GOOGLE_REFRESH_TOKEN",
    "S3_BUCKET",
  ].filter((name) => !process.env[name]?.trim());
}

async function runScheduledPoll(): Promise<void> {
  const startedAt = new Date();
  if (schedulerGlobal.gmailSyncSchedulerBusy) {
    console.info("[gmail-sync] cycle_skipped", {
      startedAt: startedAt.toISOString(),
      completedAt: new Date().toISOString(),
      reason: "previous_cycle_running",
    });
    return;
  }

  schedulerGlobal.gmailSyncSchedulerBusy = true;
  const startedAtMs = Date.now();
  console.info("[gmail-sync] cycle_started", {
    startedAt: startedAt.toISOString(),
  });

  try {
    const cycle = await withGmailSchedulerLock(pollInbox);
    if (!cycle.acquired) {
      console.info("[gmail-sync] cycle_skipped", {
        startedAt: startedAt.toISOString(),
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAtMs,
        reason: "scheduler_lock_held_elsewhere",
      });
      return;
    }

    console.info("[gmail-sync] cycle_succeeded", {
      startedAt: startedAt.toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAtMs,
      newMessages: cycle.result.processedMessages,
      skippedDuplicates: cycle.result.skippedMessages,
      ...cycle.result,
    });
  } catch (error) {
    const diagnostic = getSafeSyncDiagnostic(error);
    console.error("[gmail-sync] cycle_failed", {
      startedAt: startedAt.toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAtMs,
      newMessages: getCurrentPollProgress().processedMessages,
      skippedDuplicates: getCurrentPollProgress().skippedMessages,
      ...diagnostic,
    });
  } finally {
    schedulerGlobal.gmailSyncSchedulerBusy = false;
  }
}

function stopGmailScheduler(reason: string): void {
  if (!schedulerGlobal.gmailSyncScheduler) {
    return;
  }
  clearInterval(schedulerGlobal.gmailSyncScheduler);
  const previousIntervalMs = schedulerGlobal.gmailSyncIntervalMs;
  schedulerGlobal.gmailSyncScheduler = undefined;
  schedulerGlobal.gmailSyncIntervalMs = undefined;
  schedulerGlobal.gmailSyncNextRunAt = null;
  console.info("[gmail-sync] scheduler_stopped", { reason, previousIntervalMs });
}

export function startGmailScheduler(): void {
  if (process.env.GMAIL_SYNC_ENABLED !== "true") {
    stopGmailScheduler("disabled");
    console.info("[gmail-sync] scheduler_disabled");
    return;
  }

  if (usesPlatformScheduler()) {
    stopGmailScheduler("delegated_to_vercel_cron");
    console.info("[gmail-sync] scheduler_delegated_to_vercel_cron");
    return;
  }

  const missing = missingConfiguration();
  if (missing.length > 0) {
    stopGmailScheduler("missing_configuration");
    console.error("[gmail-sync] scheduler_not_started", {
      reason: "missing_configuration",
      missing,
    });
    return;
  }

  let intervalMs: number;
  try {
    intervalMs = getPollIntervalMs();
  } catch {
    stopGmailScheduler("invalid_interval_configuration");
    console.error("[gmail-sync] scheduler_not_started", {
      reason: "invalid_interval_configuration",
    });
    return;
  }

  if (schedulerGlobal.gmailSyncScheduler) {
    if (schedulerGlobal.gmailSyncIntervalMs === intervalMs) {
      return;
    }
    const previousIntervalMs = schedulerGlobal.gmailSyncIntervalMs;
    clearInterval(schedulerGlobal.gmailSyncScheduler);
    schedulerGlobal.gmailSyncScheduler = undefined;
    schedulerGlobal.gmailSyncIntervalMs = undefined;
    schedulerGlobal.gmailSyncNextRunAt = null;
    console.info("[gmail-sync] scheduler_reconfigured", {
      previousIntervalMs,
      intervalMs,
    });
  }

  schedulerGlobal.gmailSyncScheduler = setInterval(() => {
    const scheduledAt = schedulerGlobal.gmailSyncNextRunAt
      ? new Date(schedulerGlobal.gmailSyncNextRunAt).getTime()
      : Date.now();
    const nextAt = scheduledAt + intervalMs;
    schedulerGlobal.gmailSyncNextRunAt = new Date(
      nextAt > Date.now() ? nextAt : Date.now() + intervalMs,
    ).toISOString();
    void runScheduledPoll();
  }, intervalMs);
  schedulerGlobal.gmailSyncIntervalMs = intervalMs;
  schedulerGlobal.gmailSyncNextRunAt = new Date(Date.now() + intervalMs).toISOString();

  console.info("[gmail-sync] scheduler_started", {
    intervalMs,
    firstPoll: "immediate",
  });
  void runScheduledPoll();
}

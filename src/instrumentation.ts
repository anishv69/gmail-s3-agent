export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startGmailScheduler } = await import("@/lib/gmail-scheduler");
    startGmailScheduler();
  }
}

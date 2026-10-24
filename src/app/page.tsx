import { prisma } from "@/lib/prisma";
import { MailDashboard } from "@/components/mail-dashboard";
import { decodeEmailSnippet } from "@/lib/email-text";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 25;

type HistoryState = {
  status: "not_started" | "running" | "completed";
  processedMessages: number;
  skippedMessages: number;
  uploadedAttachments: number;
};

export default async function Home() {
  if (!process.env.DATABASE_URL) {
    return (
      <main className="grid min-h-screen place-items-center bg-slate-50 p-6">
        <section className="max-w-lg rounded-3xl border border-slate-200 bg-white p-10 shadow-xl shadow-slate-200/60">
          <span className="text-xs font-bold uppercase tracking-[0.2em] text-blue-600">
            Gmail · S3
          </span>
          <h1 className="mt-3 text-3xl font-semibold tracking-tight text-slate-950">
            Connect your inbox
          </h1>
          <p className="mt-3 text-sm leading-6 text-slate-500">
            Add the PostgreSQL connection string to your local environment and
            apply the database migration to open the archive.
          </p>
        </section>
      </main>
    );
  }

  const [emails, total, latestSync, historyState] = await Promise.all([
    prisma.email.findMany({
      where: {
        OR: [
          { gmailLabels: { has: "INBOX" } },
          { gmailLabels: { isEmpty: true } },
        ],
      },
      orderBy: [{ receivedAt: "desc" }, { id: "desc" }],
      take: PAGE_SIZE,
      select: {
        id: true,
        sender: true,
        subject: true,
        snippet: true,
        receivedAt: true,
        gmailLabels: true,
        attachments: {
          select: { id: true, fileName: true, mimeType: true, size: true },
        },
      },
    }),
    prisma.email.count({
      where: {
        OR: [
          { gmailLabels: { has: "INBOX" } },
          { gmailLabels: { isEmpty: true } },
        ],
      },
    }),
    prisma.syncState.findUnique({ where: { key: "gmail:last-synced-at" } }),
    prisma.syncState.findUnique({ where: { key: "gmail:history-sync" } }),
  ]);

  let history: HistoryState = {
    status: "not_started",
    processedMessages: 0,
    skippedMessages: 0,
    uploadedAttachments: 0,
  };
  if (historyState) {
    try {
      const parsed = JSON.parse(historyState.value) as HistoryState;
      history = {
        status: parsed.status,
        processedMessages: parsed.processedMessages,
        skippedMessages: parsed.skippedMessages,
        uploadedAttachments: parsed.uploadedAttachments,
      };
    } catch {
      history.status = "not_started";
    }
  }

  return (
    <MailDashboard
      initialEmails={emails.map((email) => ({
        ...email,
        snippet: decodeEmailSnippet(email.snippet),
        receivedAt: email.receivedAt.toISOString(),
      }))}
      initialTotal={total}
      initialLastSync={latestSync?.value ?? null}
      initialHistory={history}
      mailboxLabel={process.env.GMAIL_USER_EMAIL ?? "Mailbox"}
    />
  );
}

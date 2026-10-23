import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { hasDashboardAuthorization } from "@/lib/dashboard-auth";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

type EmailFilter = "inbox" | "sent" | "starred" | "attachments" | "archive";
const supportedFilters: EmailFilter[] = [
  "inbox",
  "sent",
  "starred",
  "attachments",
  "archive",
];

function isEmailFilter(value: string): value is EmailFilter {
  return supportedFilters.some((filter) => filter === value);
}

export async function GET(request: NextRequest) {
  if (!hasDashboardAuthorization(request)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const searchParams = request.nextUrl.searchParams;
  const query = (searchParams.get("q") ?? "").trim().slice(0, 200);
  const requestedFilter = searchParams.get("filter") ?? "inbox";
  if (!isEmailFilter(requestedFilter)) {
    return NextResponse.json({ error: "Unsupported email filter." }, { status: 400 });
  }
  const filter = requestedFilter;
  const page = Number(searchParams.get("page") ?? "1");
  const pageSize = Number(searchParams.get("pageSize") ?? "25");

  if (!Number.isSafeInteger(page) || page < 1) {
    return NextResponse.json({ error: "page must be a positive integer." }, { status: 400 });
  }
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 50) {
    return NextResponse.json(
      { error: "pageSize must be between 1 and 50." },
      { status: 400 },
    );
  }

  const where: Prisma.EmailWhereInput = {};
  if (query) {
    where.OR = [
      { sender: { contains: query, mode: "insensitive" } },
      { recipients: { contains: query, mode: "insensitive" } },
      { subject: { contains: query, mode: "insensitive" } },
      { snippet: { contains: query, mode: "insensitive" } },
      { bodyText: { contains: query, mode: "insensitive" } },
    ];
  }
  if (filter === "inbox") {
    where.AND = [
      { OR: [{ gmailLabels: { has: "INBOX" } }, { gmailLabels: { isEmpty: true } }] },
    ];
  } else if (filter === "sent") {
    where.gmailLabels = { has: "SENT" };
  } else if (filter === "starred") {
    where.gmailLabels = { has: "STARRED" };
  } else if (filter === "attachments") {
    where.attachments = { some: {} };
  } else if (filter === "archive") {
    where.AND = [
      { gmailLabels: { isEmpty: false } },
      { NOT: { gmailLabels: { has: "INBOX" } } },
      { NOT: { gmailLabels: { has: "SPAM" } } },
      { NOT: { gmailLabels: { has: "TRASH" } } },
    ];
  }

  try {
    // Fetch every matching message (ordered newest-first) so messages that
    // belong to the same Gmail thread can be grouped into a single inbox
    // row, the way Gmail's conversation view collapses them. Pagination is
    // then applied over threads rather than raw messages.
    const emails = await prisma.email.findMany({
      where,
      orderBy: [{ receivedAt: "desc" }, { id: "desc" }],
      select: {
        id: true,
        sender: true,
        subject: true,
        snippet: true,
        receivedAt: true,
        gmailLabels: true,
        gmailThreadId: true,
        attachments: { select: { id: true, fileName: true, mimeType: true, size: true } },
      },
    });

    // Group messages by thread. Since `emails` is already ordered
    // newest-first, the first message encountered for a given thread is
    // necessarily its most recent one, so grouping preserves descending
    // order across threads without needing a second sort.
    const threadOrder: string[] = [];
    const threadMessages = new Map<string, typeof emails>();
    for (const email of emails) {
      const key = email.gmailThreadId;
      const existing = threadMessages.get(key);
      if (existing) {
        existing.push(email);
      } else {
        threadMessages.set(key, [email]);
        threadOrder.push(key);
      }
    }

    const threads = threadOrder.map((key) => {
      const messages = threadMessages.get(key)!;
      const latest = messages[0];
      const isUnread = messages.some((m) => m.gmailLabels.includes("UNREAD"));
      const isStarred = messages.some((m) => m.gmailLabels.includes("STARRED"));
      const labels = new Set(latest.gmailLabels);
      if (isUnread) labels.add("UNREAD");
      if (isStarred) labels.add("STARRED");
      return {
        id: latest.id,
        threadId: latest.gmailThreadId,
        sender: latest.sender,
        subject: latest.subject,
        snippet: latest.snippet,
        receivedAt: latest.receivedAt,
        gmailLabels: Array.from(labels),
        attachments: latest.attachments,
        messageCount: messages.length,
      };
    });

    const total = threads.length;
    const start = (page - 1) * pageSize;
    const paged = threads.slice(start, start + pageSize);

    return NextResponse.json({
      emails: paged,
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize) || 1,
    });
  } catch {
    console.error("[emails] list_query_failed");
    return NextResponse.json({ error: "Unable to load archived email." }, { status: 500 });
  }
}

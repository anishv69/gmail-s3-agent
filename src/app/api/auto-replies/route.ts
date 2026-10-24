import { NextRequest, NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { AUTO_SEND_CONFIDENCE_THRESHOLD } from "@/lib/ai/auto-reply";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const status = searchParams.get("status");
    const search = searchParams.get("search");
    const requestedPage = Number.parseInt(searchParams.get("page") || "1", 10);
    const requestedLimit = Number.parseInt(searchParams.get("limit") || "25", 10);
    const page = Number.isFinite(requestedPage) ? Math.max(1, requestedPage) : 1;
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(100, Math.max(1, requestedLimit))
      : 25;
    const skip = (page - 1) * limit;

    // Build where clause
    const where: Prisma.AutoReplyWhereInput = {};
    if (status && ["draft", "sent", "pending_send", "skipped"].includes(status)) {
      where.status = status;
    }
    if (search) {
      where.OR = [
        { originalFrom: { contains: search, mode: "insensitive" } },
        { originalSubject: { contains: search, mode: "insensitive" } },
        { generatedReply: { contains: search, mode: "insensitive" } },
      ];
    }

    // Get total count
    const total = await prisma.autoReply.count({ where });

    // Get paginated replies with email data, ordered by email receivedAt (latest first)
    const replies = await prisma.autoReply.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: limit,
      skip: skip,
    });

    // Fetch emails for these replies to get receivedAt dates, then sort
    const emailIds = replies.map(r => r.emailId);
    const emails = await prisma.email.findMany({
      where: { id: { in: emailIds } },
      select: { id: true, receivedAt: true },
    });

    const emailMap = new Map(emails.map(e => [e.id, e]));

    // Sort replies by email receivedAt (latest first)
    const sortedReplies = replies.sort((a, b) => {
      const emailA = emailMap.get(a.emailId);
      const emailB = emailMap.get(b.emailId);
      if (!emailA || !emailB) return 0;
      return emailB.receivedAt.getTime() - emailA.receivedAt.getTime();
    });

    const activeSettings = await prisma.autoReplySettings.findFirst({
      where: { enabled: true, autoSendToKnown: true },
      select: { id: true },
    });
    const pendingSendCount = activeSettings
      ? await prisma.autoReply.count({
          where: {
            settingsId: activeSettings.id,
            status: "pending_send",
            shouldAutoSend: true,
            confidence: { gte: AUTO_SEND_CONFIDENCE_THRESHOLD },
          },
        })
      : 0;

    return NextResponse.json({
      data: sortedReplies,
      pendingSendCount,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error("Failed to fetch auto-replies:", error);
    return NextResponse.json(
      { error: "Failed to fetch auto-replies" },
      { status: 500 }
    );
  }
}

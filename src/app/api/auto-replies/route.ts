import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const page = parseInt(searchParams.get("page") || "1");
    const limit = parseInt(searchParams.get("limit") || "25");
    const status = searchParams.get("status");
    const search = searchParams.get("search");
    
    const skip = (page - 1) * limit;

    // Build where clause
    const where: any = {};
    if (status) where.status = status;
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
      include: {
        settings: true,
      },
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

    return NextResponse.json({
      data: sortedReplies,
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

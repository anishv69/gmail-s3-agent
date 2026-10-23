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

    // Get paginated replies
    const replies = await prisma.autoReply.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: limit,
      skip: skip,
    });

    return NextResponse.json({
      data: replies,
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

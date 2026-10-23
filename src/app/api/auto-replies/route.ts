import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET() {
  try {
    const replies = await prisma.autoReply.findMany({
      orderBy: { createdAt: "desc" },
      take: 100,
    });

    return NextResponse.json(replies);
  } catch (error) {
    console.error("Failed to fetch auto-replies:", error);
    return NextResponse.json(
      { error: "Failed to fetch auto-replies" },
      { status: 500 }
    );
  }
}

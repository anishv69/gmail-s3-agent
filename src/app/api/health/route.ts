import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

export async function GET() {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return NextResponse.json({ ok: true }, { status: 200 });
  } catch {
    console.error("[health] database_check_failed");
    return NextResponse.json({ ok: false }, { status: 503 });
  }
}

import { NextRequest, NextResponse } from "next/server";
import { findSimilarChunks } from "@/lib/ai/database";
import { createEmbeddings } from "@/lib/ai/openai";
import { hasDashboardAuthorization } from "@/lib/dashboard-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  if (!hasDashboardAuthorization(request)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  if (!process.env.OPENAI_API_KEY?.trim()) {
    return NextResponse.json(
      { error: "AI search is not configured. Add OPENAI_API_KEY on the server." },
      { status: 503 },
    );
  }
  const query = request.nextUrl.searchParams.get("q")?.trim() ?? "";
  if (!query || query.length > 1200) {
    return NextResponse.json(
      { error: "Provide a search query of 1 to 1200 characters." },
      { status: 400 },
    );
  }

  try {
    const [embedding] = await createEmbeddings([query]);
    if (!embedding) throw new Error("No query embedding returned");
    const results = await findSimilarChunks(embedding, 8, 0.3);
    return NextResponse.json(
      {
        results: results.map((result) => ({
          sourceType: result.sourceType,
          title: result.title,
          sender: result.sender,
          receivedAt: result.receivedAt?.toISOString() ?? null,
          gmailMessageId: result.gmailMessageId,
          attachmentId: result.attachmentId,
          mimeType: result.mimeType,
          score: result.score,
          excerpt: result.content.slice(0, 700),
        })),
      },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    const name = error instanceof Error ? error.name : "UnknownError";
    console.error("[ai-search] request_failed", { errorType: name });
    return NextResponse.json(
      { error: "Unable to search indexed documents." },
      { status: 502 },
    );
  }
}

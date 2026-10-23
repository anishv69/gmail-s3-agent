import { NextRequest, NextResponse } from "next/server";
import { answerQuestion } from "@/lib/ai/answer";
import { hasDashboardAuthorization } from "@/lib/dashboard-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

export async function POST(request: NextRequest) {
  if (!hasDashboardAuthorization(request)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  if (!process.env.OPENAI_API_KEY?.trim()) {
    return NextResponse.json(
      { error: "AI answering is not configured. Add OPENAI_API_KEY on the server." },
      { status: 503 },
    );
  }
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (contentLength > 8192) {
    return NextResponse.json({ error: "Question request is too large." }, { status: 413 });
  }

  try {
    const body: unknown = await request.json();
    const question =
      body && typeof body === "object" && "question" in body
        ? (body as { question?: unknown }).question
        : undefined;
    const timeZone =
      body && typeof body === "object" && "timeZone" in body
        ? (body as { timeZone?: unknown }).timeZone
        : "UTC";
    if (typeof question !== "string" || question.trim().length === 0) {
      return NextResponse.json({ error: "Enter a question." }, { status: 400 });
    }
    if (question.length > 1200) {
      return NextResponse.json(
        { error: "Questions must be 1200 characters or fewer." },
        { status: 400 },
      );
    }
    if (
      typeof timeZone !== "string" ||
      timeZone.length > 100 ||
      !isValidTimeZone(timeZone)
    ) {
      return NextResponse.json({ error: "Provide a valid IANA time zone." }, { status: 400 });
    }
    const result = await answerQuestion(question, timeZone);
    console.log(`[AI] Answer generated for: "${question}"`);
    console.log(`[AI] Response: ${result.answer.substring(0, 100)}...`);
    console.log(`[AI] Sources count: ${result.sources.length}`);
    result.sources.forEach((source, idx) => {
      console.log(`[AI] Source ${idx + 1}: ${source.title || "untitled"} from ${source.sender || "unknown"} at ${source.receivedAt || "no date"}`);
    });
    return NextResponse.json(result, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : "UnknownError";
    const message = error instanceof Error ? error.message : "";
    console.error("[ai-answer] request_failed", {
      errorType: name,
      category: /rate.?limit|429/i.test(message)
        ? "provider_rate_limited"
        : /timeout|timed out/i.test(message)
          ? "provider_timeout"
          : "answer_generation_failed",
    });
    const status = /rate.?limit|429/i.test(message) ? 429 : 502;
    return NextResponse.json(
      {
        error:
          status === 429
            ? "The AI provider is rate-limiting requests. Please try again shortly."
            : "Unable to generate an answer. Check server configuration and try again.",
      },
      { status },
    );
  }

}

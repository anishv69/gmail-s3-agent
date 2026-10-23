import { NextRequest, NextResponse } from "next/server";
import { answerQuestion } from "@/lib/ai/answer";
import type { ConversationTurn } from "@/lib/ai/answer";
import { hasDashboardAuthorization } from "@/lib/dashboard-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_HISTORY_MESSAGES = 10;
const MAX_HISTORY_MESSAGE_LENGTH = 1200;

function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

function parseHistory(value: unknown): ConversationTurn[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const turns: ConversationTurn[] = [];
  for (const item of value.slice(-MAX_HISTORY_MESSAGES)) {
    if (
      item &&
      typeof item === "object" &&
      "role" in item &&
      "content" in item &&
      (item.role === "user" || item.role === "assistant") &&
      typeof item.content === "string"
    ) {
      turns.push({
        role: item.role,
        content: item.content.slice(0, MAX_HISTORY_MESSAGE_LENGTH),
      });
    }
  }
  return turns;
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
  // Raised from 8192 to accommodate recent conversation history sent along
  // with each question (up to ~10 prior turns) for contextual follow-ups.
  if (contentLength > 32768) {
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
    const history = parseHistory(
      body && typeof body === "object" && "history" in body
        ? (body as { history?: unknown }).history
        : undefined,
    );
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
    const result = await answerQuestion(question, timeZone, history);
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

import { NextRequest, NextResponse } from "next/server";
import { hasDashboardAuthorization } from "@/lib/dashboard-auth";
import { decodeEmailSnippet, normalizeEmailText } from "@/lib/email-text";
import { prisma } from "@/lib/prisma";
import { sanitizeEmailHtml } from "@/lib/sanitize-email-html";

export const runtime = "nodejs";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  if (!hasDashboardAuthorization(request)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const { id } = await context.params;
  try {
    const email = await prisma.email.findUnique({
      where: { id },
      select: {
        id: true,
        sender: true,
        recipients: true,
        subject: true,
        snippet: true,
        bodyText: true,
        bodyHtml: true,
        receivedAt: true,
        gmailMessageId: true,
        gmailLabels: true,
        attachments: {
          select: { id: true, fileName: true, mimeType: true, size: true },
        },
      },
    });
    if (!email) {
      return NextResponse.json({ error: "Email not found." }, { status: 404 });
    }
    return NextResponse.json({
      email: {
        ...email,
        snippet: decodeEmailSnippet(email.snippet),
        bodyText: normalizeEmailText(email.bodyText),
        bodyHtml: email.bodyHtml ? sanitizeEmailHtml(email.bodyHtml) : null,
      },
    });
  } catch {
    console.error("[emails] detail_query_failed");
    return NextResponse.json({ error: "Unable to load email details." }, { status: 500 });
  }
}

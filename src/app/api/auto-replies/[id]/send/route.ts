import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { sendEmailViaGmail } from "@/lib/gmail-send";

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const body = await request.json();
    const { reply } = body;

    if (typeof reply !== "string" || !reply.trim() || reply.length > 30_000) {
      return NextResponse.json(
        { error: "Reply must contain between 1 and 30000 characters." },
        { status: 400 },
      );
    }

    // Get the auto-reply record
    const autoReply = await prisma.autoReply.findUnique({
      where: { id },
    });

    if (!autoReply) {
      return NextResponse.json(
        { error: "Auto-reply not found" },
        { status: 404 }
      );
    }

    if (autoReply.status !== "draft" && autoReply.status !== "pending_send") {
      return NextResponse.json(
        { error: "Only draft or pending replies can be sent." },
        { status: 409 },
      );
    }

    const originalEmail = await prisma.email.findUnique({
      where: { id: autoReply.emailId },
      select: { gmailMessageId: true, gmailThreadId: true },
    });

    if (!originalEmail) {
      return NextResponse.json(
        { error: "Original email not found; this reply cannot be threaded safely." },
        { status: 409 },
      );
    }

    // Send the email via Gmail
    await sendEmailViaGmail({
      to: autoReply.originalFrom,
      subject: `Re: ${autoReply.originalSubject}`,
      body: reply,
      threadId: originalEmail.gmailThreadId,
      gmailMessageId: originalEmail.gmailMessageId,
    });

    // Update the status
    await prisma.autoReply.update({
      where: { id },
      data: {
        status: "sent",
        sentAt: new Date(),
        generatedReply: reply, // Save edited version if changed
      },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to send auto-reply.";
    console.error("[auto-reply] send_failed", { error: message });
    return NextResponse.json(
      { error: message },
      { status: 500 }
    );
  }
}

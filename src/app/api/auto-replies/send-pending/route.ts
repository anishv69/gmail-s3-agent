import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { sendEmailViaGmail } from "@/lib/gmail-send";
import { AUTO_SEND_CONFIDENCE_THRESHOLD } from "@/lib/ai/auto-reply";

export async function POST() {
  try {
    // Get auto-reply settings
    const settings = await prisma.autoReplySettings.findFirst({
      where: { enabled: true },
    });

    if (!settings || !settings.autoSendToKnown) {
      return NextResponse.json({
        success: false,
        message: "Auto-send is not enabled in settings",
      }, { status: 400 });
    }

    // Get all pending auto-replies
    const pendingReplies = await prisma.autoReply.findMany({
      where: {
        status: "pending_send",
        settingsId: settings.id,
        shouldAutoSend: true,
        confidence: { gte: AUTO_SEND_CONFIDENCE_THRESHOLD },
      },
    });

    if (pendingReplies.length === 0) {
      return NextResponse.json({
        success: true,
        message: "No pending replies to send",
        sent: 0,
      });
    }

    const originalEmails = await prisma.email.findMany({
      where: { id: { in: pendingReplies.map((reply) => reply.emailId) } },
      select: { id: true, gmailMessageId: true, gmailThreadId: true },
    });
    const originalEmailById = new Map(originalEmails.map((email) => [email.id, email]));

    let sentCount = 0;
    const errors: string[] = [];

    // Send each pending reply
    for (const reply of pendingReplies) {
      try {
        // Check if sender is in exclude list
        if (
          settings.excludeSenders.some(
            (sender) => sender.trim().toLowerCase() === reply.originalFrom.trim().toLowerCase(),
          )
        ) {
          await prisma.autoReply.update({
            where: { id: reply.id },
            data: { status: "skipped" },
          });
          continue;
        }

        // Check if subject matches exclude patterns
        const subjectMatches = settings.excludeSubjects.some((pattern) =>
          reply.originalSubject.toLowerCase().includes(pattern.toLowerCase())
        );

        if (subjectMatches) {
          await prisma.autoReply.update({
            where: { id: reply.id },
            data: { status: "skipped" },
          });
          continue;
        }

        const originalEmail = originalEmailById.get(reply.emailId);
        if (!originalEmail) {
          errors.push(`Original email not found for reply ${reply.id}`);
          continue;
        }

        // Send the email via Gmail
        await sendEmailViaGmail({
          to: reply.originalFrom,
          subject: `Re: ${reply.originalSubject}`,
          body: reply.generatedReply,
          threadId: originalEmail.gmailThreadId,
          gmailMessageId: originalEmail.gmailMessageId,
        });

        // Update the status to sent
        await prisma.autoReply.update({
          where: { id: reply.id },
          data: {
            status: "sent",
            sentAt: new Date(),
          },
        });

        sentCount++;
        console.log(
          `[Auto-Reply] Sent reply to ${reply.originalFrom} for "${reply.originalSubject}"`
        );
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : "Unknown error";
        errors.push(`Failed to send reply ${reply.id}: ${errorMsg}`);
        console.error("[auto-reply] pending_send_failed", {
          replyId: reply.id,
          error: errorMsg,
        });
      }
    }

    return NextResponse.json({
      success: true,
      sent: sentCount,
      total: pendingReplies.length,
      errors: errors.length > 0 ? errors : undefined,
      message: `Successfully sent ${sentCount} of ${pendingReplies.length} pending replies`,
    });
  } catch (error) {
    console.error("[Auto-Reply] Send pending error:", error);
    return NextResponse.json(
      {
        error: "Failed to process pending replies",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}

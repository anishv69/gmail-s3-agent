import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { sendEmailViaGmail } from "@/lib/gmail-send";

export async function POST(request: NextRequest) {
  try {
    // Get auto-reply settings
    const settings = await prisma.autoReplySettings.findFirst({
      where: { enabled: true },
    });

    if (!settings || !settings.autoSendToKnown) {
      return NextResponse.json({
        success: false,
        message: "Auto-send is not enabled in settings",
      });
    }

    // Get all pending auto-replies
    const pendingReplies = await prisma.autoReply.findMany({
      where: {
        status: "pending_send",
        settingsId: settings.id,
      },
    });

    if (pendingReplies.length === 0) {
      return NextResponse.json({
        success: true,
        message: "No pending replies to send",
        sent: 0,
      });
    }

    let sentCount = 0;
    const errors: string[] = [];

    // Send each pending reply
    for (const reply of pendingReplies) {
      try {
        // Check if sender is in exclude list
        if (
          settings.excludeSenders.includes(reply.originalFrom.toLowerCase())
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

        // Send the email via Gmail
        await sendEmailViaGmail({
          to: reply.originalFrom,
          subject: `Re: ${reply.originalSubject}`,
          body: reply.generatedReply,
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
        console.error(`[Auto-Reply] Failed to send reply ${reply.id}:`, error);
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

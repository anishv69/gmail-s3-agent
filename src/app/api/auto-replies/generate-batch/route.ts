import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  generateAutoReplyWithTemplate,
} from "@/lib/ai/auto-reply";

export async function POST(request: NextRequest) {
  try {
    // Get auto-reply settings
    const settings = await prisma.autoReplySettings.findFirst({
      where: { enabled: true },
    });

    if (!settings) {
      return NextResponse.json({
        error: "Auto-reply is not enabled",
      }, { status: 400 });
    }

    // Get emails that don't have auto-replies yet
    // First get all emails, then filter out those with replies
    const emails = await prisma.email.findMany({
      select: {
        id: true,
        sender: true,
        subject: true,
        bodyText: true,
        bodyHtml: true,
      },
      orderBy: {
        receivedAt: "desc",
      },
      take: 20, // Process 20 at a time
    });

    // Get IDs of emails that already have auto-replies
    const repliedEmailIds = await prisma.autoReply.findMany({
      select: {
        emailId: true,
      },
      where: {
        settingsId: settings.id,
      },
    });

    const repliedSet = new Set(repliedEmailIds.map((r) => r.emailId));

    // Filter to only emails without replies
    const emailsWithoutReplies = emails.filter((e) => !repliedSet.has(e.id));

    if (emailsWithoutReplies.length === 0) {
      return NextResponse.json({
        message: "No emails pending auto-reply generation",
        generated: 0,
      });
    }

    let generatedCount = 0;
    const errors: string[] = [];

    for (const email of emailsWithoutReplies) {
      try {
        // Check if sender is in exclude list
        if (
          settings.excludeSenders.some((s) => s.toLowerCase() === email.sender.toLowerCase())
        ) {
          continue;
        }

        // Check if subject matches exclude patterns
        const subjectMatches = settings.excludeSubjects.some((pattern) =>
          email.subject.toLowerCase().includes(pattern.toLowerCase())
        );

        if (subjectMatches) {
          continue;
        }

        // Generate reply
        const reply = await generateAutoReplyWithTemplate(
          {
            from: email.sender,
            subject: email.subject,
            body: email.bodyText || "",
            snippet: email.bodyText?.substring(0, 200) || "",
          },
          settings.responseTemplate || undefined,
          settings.responseTone as "professional" | "friendly" | "formal"
        );

        // Save as auto-reply
        await prisma.autoReply.create({
          data: {
            emailId: email.id,
            settingsId: settings.id,
            originalFrom: email.sender,
            originalTo: "user@example.com",
            originalSubject: email.subject,
            generatedReply: reply.reply,
            status: settings.autoSendToKnown ? "pending_send" : "draft",
            confidence: reply.confidence,
            shouldAutoSend: settings.autoSendToKnown && reply.shouldAutoSend,
          },
        });

        generatedCount++;
        console.log(
          `[Auto-Reply] Generated reply for email from ${email.sender}`
        );
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : "Unknown error";
        errors.push(`Failed to generate reply for ${email.id}: ${errorMsg}`);
        console.error(`[Auto-Reply] Failed to generate reply for ${email.id}:`, error);
      }
    }

    return NextResponse.json({
      success: true,
      generated: generatedCount,
      total: emailsWithoutReplies.length,
      errors: errors.length > 0 ? errors : undefined,
      message: `Generated ${generatedCount} auto-replies`,
    });
  } catch (error) {
    console.error("[Auto-Reply] Generate batch error:", error);
    return NextResponse.json(
      {
        error: "Failed to generate auto-replies",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}

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

    // Get ALL emails that don't have auto-replies yet
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
      // Don't limit - get all emails
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

    console.log(`[Auto-Reply] Starting batch generation for ${emailsWithoutReplies.length} emails`);

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

        // Upsert auto-reply (update if exists, create if not)
        await prisma.autoReply.upsert({
          where: {
            emailId_settingsId: {
              emailId: email.id,
              settingsId: settings.id,
            },
          },
          update: {
            generatedReply: reply.reply,
            confidence: reply.confidence,
            shouldAutoSend: settings.autoSendToKnown && reply.shouldAutoSend,
          },
          create: {
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
        if (generatedCount % 10 === 0) {
          console.log(`[Auto-Reply] Generated ${generatedCount} replies so far...`);
        }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : "Unknown error";
        errors.push(`Failed to generate reply for ${email.id}: ${errorMsg}`);
        console.error(`[Auto-Reply] Failed to generate reply for ${email.id}:`, error);
      }
    }

    console.log(`[Auto-Reply] Batch generation complete: ${generatedCount} replies generated`);

    return NextResponse.json({
      success: true,
      generated: generatedCount,
      total: emailsWithoutReplies.length,
      skipped: emailsWithoutReplies.length - generatedCount,
      errors: errors.length > 0 ? errors.slice(0, 5) : undefined, // Show first 5 errors only
      message: `Generated ${generatedCount} auto-replies from ${emailsWithoutReplies.length} emails`,
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

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  generateAutoReplyWithTemplate,
} from "@/lib/ai/auto-reply";

// Process this many emails per request, so each HTTP call stays fast and
// the frontend can show progress across multiple calls instead of one
// long blocking request.
const BATCH_SIZE = 25;
// Number of OpenAI calls to run in parallel within a batch.
const CONCURRENCY = 5;

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
        remaining: 0,
      });
    }

    // Only take a bounded batch so this request returns quickly. The
    // frontend calls this endpoint repeatedly until `remaining` is 0.
    const batch = emailsWithoutReplies.slice(0, BATCH_SIZE);
    const remainingAfterBatch = emailsWithoutReplies.length - batch.length;

    let generatedCount = 0;
    const errors: string[] = [];

    console.log(`[Auto-Reply] Generating batch of ${batch.length} (of ${emailsWithoutReplies.length} pending)`);

    // Process emails concurrently in small chunks instead of one at a
    // time, so a batch of 25 only takes a handful of round-trips to the
    // LLM instead of 25 sequential ones.
    for (let i = 0; i < batch.length; i += CONCURRENCY) {
      const chunk = batch.slice(i, i + CONCURRENCY);

      const results = await Promise.allSettled(
        chunk.map(async (email) => {
          // Check if sender is in exclude list
          if (
            settings.excludeSenders.some((s) => s.toLowerCase() === email.sender.toLowerCase())
          ) {
            return { skipped: true };
          }

          // Check if subject matches exclude patterns
          const subjectMatches = settings.excludeSubjects.some((pattern) =>
            email.subject.toLowerCase().includes(pattern.toLowerCase())
          );

          if (subjectMatches) {
            return { skipped: true };
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

          return { skipped: false, emailId: email.id };
        })
      );

      for (let j = 0; j < results.length; j++) {
        const result = results[j];
        if (result.status === "fulfilled") {
          if (!result.value.skipped) generatedCount++;
        } else {
          const errorMsg = result.reason instanceof Error ? result.reason.message : "Unknown error";
          errors.push(`Failed to generate reply for ${chunk[j].id}: ${errorMsg}`);
          console.error(`[Auto-Reply] Failed to generate reply for ${chunk[j].id}:`, result.reason);
        }
      }
    }

    console.log(`[Auto-Reply] Batch complete: ${generatedCount} generated, ${remainingAfterBatch} remaining`);

    return NextResponse.json({
      success: true,
      generated: generatedCount,
      total: batch.length,
      skipped: batch.length - generatedCount,
      remaining: remainingAfterBatch,
      errors: errors.length > 0 ? errors.slice(0, 5) : undefined, // Show first 5 errors only
      message: `Generated ${generatedCount} auto-replies from ${batch.length} emails`,
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

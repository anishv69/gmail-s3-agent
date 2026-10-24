import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  AUTO_SEND_CONFIDENCE_THRESHOLD,
  generateAutoReplyWithTemplate,
} from "@/lib/ai/auto-reply";

// Process this many emails per request, so each HTTP call stays fast and
// the frontend can show progress across multiple calls instead of one
// long blocking request.
const BATCH_SIZE = 25;
// Number of OpenAI calls to run in parallel within a batch.
const CONCURRENCY = 5;

export async function POST() {
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

    // Get IDs of emails that already have auto-replies
    const repliedEmailIds = await prisma.autoReply.findMany({
      select: {
        emailId: true,
      },
      where: {
        settingsId: settings.id,
      },
    });

    const repliedIds = repliedEmailIds.map((r) => r.emailId);
    const pendingCount = await prisma.email.count({
      where: repliedIds.length ? { id: { notIn: repliedIds } } : undefined,
    });

    if (pendingCount === 0) {
      return NextResponse.json({
        message: "No emails pending auto-reply generation",
        generated: 0,
        skipped: 0,
        remaining: 0,
      });
    }

    // Only load a bounded batch of emails without a saved result.
    const batch = await prisma.email.findMany({
      where: repliedIds.length ? { id: { notIn: repliedIds } } : undefined,
      select: { id: true, sender: true, subject: true, bodyText: true },
      orderBy: { receivedAt: "desc" },
      take: BATCH_SIZE,
    });

    let generatedCount = 0;
    let skippedCount = 0;
    const errors: string[] = [];

    console.log(`[Auto-Reply] Generating batch of ${batch.length} (of ${pendingCount} pending)`);

    // Process emails concurrently in small chunks instead of one at a
    // time, so a batch of 25 only takes a handful of round-trips to the
    // LLM instead of 25 sequential ones.
    for (let i = 0; i < batch.length; i += CONCURRENCY) {
      const chunk = batch.slice(i, i + CONCURRENCY);

      const results = await Promise.allSettled(
        chunk.map(async (email) => {
          // Check if sender is in exclude list
          const excludedBySender = settings.excludeSenders.some(
            (sender) => sender.trim().toLowerCase() === email.sender.trim().toLowerCase(),
          );

          // Check if subject matches exclude patterns
          const subjectMatches = settings.excludeSubjects.some((pattern) =>
            email.subject.toLowerCase().includes(pattern.trim().toLowerCase())
          );

          if (excludedBySender || subjectMatches) {
            await prisma.autoReply.upsert({
              where: {
                emailId_settingsId: { emailId: email.id, settingsId: settings.id },
              },
              update: { status: "skipped", shouldAutoSend: false },
              create: {
                emailId: email.id,
                settingsId: settings.id,
                originalFrom: email.sender,
                originalTo: process.env.GMAIL_USER_EMAIL || "",
                originalSubject: email.subject,
                generatedReply: "",
                status: "skipped",
                confidence: 0,
                shouldAutoSend: false,
              },
            });
            return { skipped: true, emailId: email.id };
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

          const shouldAutoSend =
            settings.autoSendToKnown &&
            reply.shouldAutoSend === true &&
            reply.confidence >= AUTO_SEND_CONFIDENCE_THRESHOLD;

          // Save conservative or ambiguous replies as drafts for review.
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
              shouldAutoSend,
            },
            create: {
              emailId: email.id,
              settingsId: settings.id,
              originalFrom: email.sender,
              originalTo: process.env.GMAIL_USER_EMAIL || "",
              originalSubject: email.subject,
              generatedReply: reply.reply,
              status: shouldAutoSend ? "pending_send" : "draft",
              confidence: reply.confidence,
              shouldAutoSend,
            },
          });

          return { skipped: false, emailId: email.id };
        })
      );

      for (let j = 0; j < results.length; j++) {
        const result = results[j];
        if (result.status === "fulfilled") {
          if (result.value.skipped) skippedCount++;
          else generatedCount++;
        } else {
          const errorMsg = result.reason instanceof Error ? result.reason.message : "Unknown error";
          errors.push(`Failed to generate reply for ${chunk[j].id}: ${errorMsg}`);
          console.error(`[Auto-Reply] Failed to generate reply for ${chunk[j].id}:`, result.reason);
        }
      }
    }

    const savedEmailIds = await prisma.autoReply.findMany({
      where: { settingsId: settings.id },
      select: { emailId: true },
    });
    const savedIds = savedEmailIds.map((reply) => reply.emailId);
    const remaining = await prisma.email.count({
      where: savedIds.length ? { id: { notIn: savedIds } } : undefined,
    });

    console.log(`[Auto-Reply] Batch complete: ${generatedCount} generated, ${skippedCount} excluded, ${remaining} remaining`);

    return NextResponse.json({
      success: true,
      generated: generatedCount,
      total: batch.length,
      skipped: skippedCount,
      remaining,
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

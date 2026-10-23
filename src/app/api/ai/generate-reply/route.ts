import { NextRequest, NextResponse } from "next/server";
import { generateAutoReply, type EmailToReply } from "@/lib/ai/auto-reply";
import { prisma } from "@/lib/prisma";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { emailId, from, subject, body: emailBody, snippet } = body;

    if (!from || !subject || !emailBody) {
      return NextResponse.json(
        { error: "Missing required fields: from, subject, body" },
        { status: 400 }
      );
    }

    // Generate the reply
    const generatedReply = await generateAutoReply({
      from,
      subject,
      body: emailBody,
      snippet: snippet || emailBody.substring(0, 200),
    } as EmailToReply);

    // If we have emailId and settings, save to database
    let autoReply = null;
    if (emailId) {
      const settings = await prisma.autoReplySettings.findFirst({
        where: { enabled: true },
      });

      if (settings) {
        autoReply = await prisma.autoReply.create({
          data: {
            emailId,
            settingsId: settings.id,
            originalFrom: from,
            originalTo: process.env.GMAIL_USER_EMAIL || "user@gmail.com",
            originalSubject: subject,
            generatedReply: generatedReply.reply,
            confidence: generatedReply.confidence,
            shouldAutoSend: generatedReply.shouldAutoSend,
            status: generatedReply.shouldAutoSend ? "pending_send" : "draft",
          },
        });
      }
    }

    return NextResponse.json({
      reply: generatedReply.reply,
      tone: generatedReply.tone,
      confidence: generatedReply.confidence,
      shouldAutoSend: generatedReply.shouldAutoSend,
      autoReplyId: autoReply?.id,
    });
  } catch (error) {
    console.error("Auto-reply generation error:", error);
    return NextResponse.json(
      { error: "Failed to generate auto-reply" },
      { status: 500 }
    );
  }
}

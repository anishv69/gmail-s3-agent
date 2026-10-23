import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { sendEmailViaGmail } from "@/lib/gmail-send";

export async function POST(
  request: NextRequest,
  context: any
) {
  try {
    const { id } = await context.params;
    const body = await request.json();
    const { reply } = body;

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

    // Send the email via Gmail
    await sendEmailViaGmail({
      to: autoReply.originalFrom,
      subject: `Re: ${autoReply.originalSubject}`,
      body: reply,
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
    console.error("Failed to send auto-reply:", error);
    return NextResponse.json(
      { error: "Failed to send auto-reply" },
      { status: 500 }
    );
  }
}

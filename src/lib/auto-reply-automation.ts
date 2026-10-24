import { prisma } from "@/lib/prisma";
import {
  AUTO_SEND_CONFIDENCE_THRESHOLD,
  generateAutoReplyWithTemplate,
} from "@/lib/ai/auto-reply";
import { sendEmailViaGmail } from "@/lib/gmail-send";

function extractEmailAddress(value: string): string {
  const match = value.match(/<([^>]+)>/);
  return (match?.[1] ?? value).trim().toLowerCase();
}

function isAutomatedSender(sender: string): boolean {
  const address = extractEmailAddress(sender);
  return /^(?:no[._-]?reply|do[._-]?not[._-]?reply|mailer-daemon|postmaster)@/i.test(
    address,
  );
}

function isAutomatedSubject(subject: string): boolean {
  return /\b(?:automatic reply|auto.?reply|out of office|delivery status notification|undelivered mail|failure notice)\b/i.test(
    subject,
  );
}

export async function processAutomaticReply(emailId: string): Promise<void> {
  const settings = await prisma.autoReplySettings.findFirst({
    where: { enabled: true },
    orderBy: { updatedAt: "desc" },
  });
  if (!settings) return;

  const email = await prisma.email.findUnique({
    where: { id: emailId },
    select: {
      id: true,
      gmailMessageId: true,
      gmailThreadId: true,
      sender: true,
      subject: true,
      bodyText: true,
    },
  });
  if (!email) return;

  const alreadyProcessed = await prisma.autoReply.findUnique({
    where: {
      emailId_settingsId: { emailId: email.id, settingsId: settings.id },
    },
    select: { id: true },
  });
  if (alreadyProcessed) return;

  const senderAddress = extractEmailAddress(email.sender);
  const mailboxAddress = process.env.GMAIL_USER_EMAIL?.trim().toLowerCase();
  const excludedBySender = settings.excludeSenders.some(
    (sender) => extractEmailAddress(sender) === senderAddress,
  );
  const excludedBySubject = settings.excludeSubjects.some((pattern) =>
    email.subject.toLowerCase().includes(pattern.trim().toLowerCase()),
  );
  const shouldSkip =
    !senderAddress ||
    senderAddress === mailboxAddress ||
    isAutomatedSender(senderAddress) ||
    isAutomatedSubject(email.subject) ||
    excludedBySender ||
    excludedBySubject;

  if (shouldSkip) {
    await prisma.autoReply.create({
      data: {
        emailId: email.id,
        settingsId: settings.id,
        originalFrom: email.sender,
        originalTo: mailboxAddress ?? "",
        originalSubject: email.subject,
        generatedReply: "",
        status: "skipped",
        confidence: 0,
        shouldAutoSend: false,
      },
    });
    return;
  }

  const generated = await generateAutoReplyWithTemplate(
    {
      from: email.sender,
      subject: email.subject,
      body: email.bodyText,
      snippet: email.bodyText.substring(0, 200),
    },
    settings.responseTemplate || undefined,
    settings.responseTone as "professional" | "friendly" | "formal",
  );
  const eligibleForAutoSend =
    settings.autoSendToKnown &&
    generated.shouldAutoSend &&
    generated.confidence >= AUTO_SEND_CONFIDENCE_THRESHOLD;

  const reply = await prisma.autoReply.create({
    data: {
      emailId: email.id,
      settingsId: settings.id,
      originalFrom: email.sender,
      originalTo: mailboxAddress ?? "",
      originalSubject: email.subject,
      generatedReply: generated.reply,
      status: eligibleForAutoSend ? "pending_send" : "draft",
      confidence: generated.confidence,
      shouldAutoSend: eligibleForAutoSend,
    },
  });

  if (!eligibleForAutoSend) return;

  try {
    await sendEmailViaGmail({
      to: email.sender,
      subject: `Re: ${email.subject}`,
      body: generated.reply,
      threadId: email.gmailThreadId,
      gmailMessageId: email.gmailMessageId,
    });
    await prisma.autoReply.update({
      where: { id: reply.id },
      data: { status: "sent", sentAt: new Date() },
    });
    console.info("[auto-reply] automatic_reply_sent", { replyId: reply.id });
  } catch (error) {
    // Leave it in pending_send so the user can inspect and retry from the UI.
    console.error("[auto-reply] automatic_reply_send_failed", {
      replyId: reply.id,
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
}

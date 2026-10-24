import { google, gmail_v1 } from "googleapis";

function createGmailClient(): gmail_v1.Gmail {
  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    ""
  );
  auth.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
  return google.gmail({ version: "v1", auth });
}

export async function sendEmailViaGmail({
  to,
  subject,
  body,
  threadId,
  gmailMessageId,
}: {
  to: string;
  subject: string;
  body: string;
  threadId?: string;
  gmailMessageId?: string;
}): Promise<{ messageId: string }> {
  const gmail = createGmailClient();
  let inReplyTo: string | undefined;
  let references: string | undefined;

  if (gmailMessageId) {
    const original = await gmail.users.messages.get({
      userId: "me",
      id: gmailMessageId,
      format: "metadata",
      metadataHeaders: ["Message-ID", "References"],
    });
    const headers = original.data.payload?.headers || [];
    inReplyTo = headers.find((header) => header.name?.toLowerCase() === "message-id")?.value || undefined;
    references = headers.find((header) => header.name?.toLowerCase() === "references")?.value || undefined;

    if (!inReplyTo) {
      throw new Error("Original Gmail message is missing its Message-ID header");
    }
  }

  const replySubject = /^re\s*:/i.test(subject) ? subject : `Re: ${subject}`;
  const safeHeader = (value: string) => value.replace(/[\r\n]+/g, " ").trim();

  // Create the email message RFC 2822 format
  const headers = [
    `To: ${safeHeader(to)}`,
    `Subject: ${safeHeader(replySubject)}`,
    inReplyTo ? `In-Reply-To: ${inReplyTo}` : undefined,
    inReplyTo ? `References: ${[references, inReplyTo].filter(Boolean).join(" ")}` : undefined,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
  ].filter((header): header is string => Boolean(header));
  const normalizedBody = body.replace(/\r?\n/g, "\r\n");
  const message = `${headers.join("\r\n")}\r\n\r\n${normalizedBody}`;

  // Encode the message in base64url format
  const encodedMessage = Buffer.from(message)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  try {
    const result = await gmail.users.messages.send({
      userId: "me",
      requestBody: {
        raw: encodedMessage,
        ...(threadId ? { threadId } : {}),
      },
    });

    return { messageId: result.data.id || "" };
  } catch (error) {
    const gmailError = error as {
      code?: number;
      response?: { status?: number; data?: { error?: { message?: string } } };
    };
    const status = gmailError.response?.status ?? gmailError.code;
    const reason = gmailError.response?.data?.error?.message || "Unknown Gmail API error";
    console.error("[gmail-send] message_send_failed", { status, reason });

    if (status === 403 && reason.toLowerCase().includes("scope")) {
      throw new Error(
        "Gmail authorization is missing the gmail.send permission. Add that scope and authorize a new refresh token, then restart the app.",
      );
    }

    throw new Error(`Gmail could not send this reply (HTTP ${status ?? "unknown"}).`);
  }
}

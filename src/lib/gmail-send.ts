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
  inReplyTo,
}: {
  to: string;
  subject: string;
  body: string;
  inReplyTo?: string;
}): Promise<{ messageId: string }> {
  const gmail = createGmailClient();

  // Create the email message RFC 2822 format
  const message = [
    `To: ${to}`,
    `Subject: ${subject}`,
    inReplyTo ? `In-Reply-To: ${inReplyTo}` : undefined,
    inReplyTo ? `References: ${inReplyTo}` : undefined,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "",
    body,
  ]
    .filter(Boolean)
    .join("\n");

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
      },
    });

    return { messageId: result.data.id || "" };
  } catch (error) {
    console.error("Failed to send email via Gmail:", error);
    throw new Error("Failed to send email");
  }
}

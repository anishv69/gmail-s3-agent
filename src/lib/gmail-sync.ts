import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Prisma } from "@prisma/client";
import { google, gmail_v1 } from "googleapis";
import { prisma } from "@/lib/prisma";
import { processAutomaticReply } from "@/lib/auto-reply-automation";

const SYNC_STATE_KEY = "gmail:last-synced-at";
const SYNC_STATUS_KEY = "gmail:sync-status";
const HISTORY_SYNC_STATE_KEY = "gmail:history-sync";
const OVERLAP_MS = 5 * 60 * 1000;

type StoredAttachment = {
  gmailAttachmentId: string;
  fileName: string;
  mimeType: string;
  size: number;
  s3Key: string;
};

export type PollSummary = {
  processedMessages: number;
  skippedMessages: number;
  uploadedAttachments: number;
};

export type GmailSyncStatus = {
  status: "idle" | "running" | "success" | "error";
  lastAttemptAt: string | null;
  lastSuccessfulAt: string | null;
  processedMessages: number;
  skippedMessages: number;
  uploadedAttachments: number;
  errorMessage: string | null;
};

export type HistorySyncState = {
  status: "not_started" | "running" | "completed";
  nextPageToken: string | null;
  processedMessages: number;
  skippedMessages: number;
  uploadedAttachments: number;
};

let activeSync: Promise<PollSummary> | undefined;
let lastPollProgress: PollSummary = {
  processedMessages: 0,
  skippedMessages: 0,
  uploadedAttachments: 0,
};

export function getCurrentPollProgress(): PollSummary {
  return { ...lastPollProgress };
}

function syncErrorMessage(diagnostic: ReturnType<typeof getSafeSyncDiagnostic>): string {
  switch (diagnostic.category) {
    case "refresh_token_rejected":
      return "Gmail rejected the refresh token. Re-authorize the Gmail connection.";
    case "oauth_client_rejected":
      return "Google rejected the OAuth client configuration.";
    case "gmail_scope_insufficient":
    case "gmail_permission_denied":
      return "Gmail access was denied. Verify that the read-only Gmail permission is authorized.";
    case "gmail_api_not_enabled":
      return "The Gmail API is not enabled for the configured Google Cloud project.";
    case "gmail_rate_limited":
      return "Gmail rate-limited synchronization. The scheduler will retry.";
    case "gmail_account_policy_denied":
      return "The Google account policy denied Gmail synchronization.";
    case "s3_access_denied":
      return "S3 denied an attachment upload. Check the app identity's scoped bucket permissions.";
    case "s3_bucket_not_found":
      return "The configured S3 bucket was not found.";
    case "database_error":
    case "network_error":
      return "A database or network error prevented Gmail synchronization.";
    case "configuration_or_sync_error":
      return "A configuration or message-processing error prevented Gmail synchronization.";
    default:
      return "Gmail synchronization failed. Check the safe server diagnostic for details.";
  }
}

async function writeSyncStatus(status: GmailSyncStatus): Promise<void> {
  await prisma.syncState.upsert({
    where: { key: SYNC_STATUS_KEY },
    create: { key: SYNC_STATUS_KEY, value: JSON.stringify(status) },
    update: { value: JSON.stringify(status) },
  });
}

export async function getGmailSyncStatus(): Promise<GmailSyncStatus> {
  const [storedStatus, lastSync] = await Promise.all([
    prisma.syncState.findUnique({ where: { key: SYNC_STATUS_KEY } }),
    prisma.syncState.findUnique({ where: { key: SYNC_STATE_KEY } }),
  ]);
  const checkpoint = lastSync?.value ?? null;

  if (!storedStatus) {
    return {
      status: checkpoint ? "success" : "idle",
      lastAttemptAt: checkpoint,
      lastSuccessfulAt: checkpoint,
      processedMessages: 0,
      skippedMessages: 0,
      uploadedAttachments: 0,
      errorMessage: null,
    };
  }

  try {
    const parsed = JSON.parse(storedStatus.value) as GmailSyncStatus;
    if (
      !["idle", "running", "success", "error"].includes(parsed.status) ||
      (parsed.lastAttemptAt !== null && typeof parsed.lastAttemptAt !== "string") ||
      (parsed.lastSuccessfulAt !== null &&
        typeof parsed.lastSuccessfulAt !== "string") ||
      !Number.isSafeInteger(parsed.processedMessages) ||
      !Number.isSafeInteger(parsed.skippedMessages) ||
      !Number.isSafeInteger(parsed.uploadedAttachments) ||
      (parsed.errorMessage !== null && typeof parsed.errorMessage !== "string")
    ) {
      throw new Error("Invalid stored sync status");
    }
    const lastSuccessfulAt =
      parsed.lastSuccessfulAt && checkpoint
        ? new Date(parsed.lastSuccessfulAt).getTime() >= new Date(checkpoint).getTime()
          ? parsed.lastSuccessfulAt
          : checkpoint
        : parsed.lastSuccessfulAt ?? checkpoint;
    return {
      ...parsed,
      lastSuccessfulAt,
    };
  } catch {
    return {
      status: "error",
      lastAttemptAt: checkpoint,
      lastSuccessfulAt: checkpoint,
      processedMessages: 0,
      skippedMessages: 0,
      uploadedAttachments: 0,
      errorMessage: "Stored synchronization status is invalid.",
    };
  }
}

export function getSafeSyncDiagnostic(error: unknown): {
  category: string;
  httpStatus?: number;
  serviceCode?: string;
  serviceReason?: string;
} {
  if (!error || typeof error !== "object") {
    return { category: "unknown_error" };
  }

  const value = error as {
    name?: unknown;
    code?: unknown;
    response?: {
      status?: unknown;
      data?: {
        error?: unknown;
      };
    };
    $metadata?: { httpStatusCode?: unknown };
  };
  const googleStatus =
    typeof value.response?.status === "number"
      ? value.response.status
      : undefined;
  const awsStatus =
    typeof value.$metadata?.httpStatusCode === "number"
      ? value.$metadata.httpStatusCode
      : undefined;
  const status = googleStatus ?? awsStatus;
  const rawServiceCode =
    typeof value.response?.data?.error === "string"
      ? value.response.data.error
      : typeof value.code === "string"
        ? value.code
        : undefined;
  const rawGoogleError = value.response?.data?.error;
  const rawServiceReason =
    rawGoogleError && typeof rawGoogleError === "object"
      ? (rawGoogleError as { errors?: Array<{ reason?: unknown }> }).errors?.[0]
          ?.reason
      : undefined;
  const allowedServiceCodes = new Set([
    "invalid_grant",
    "invalid_client",
    "unauthorized_client",
    "access_denied",
    "insufficientPermissions",
    "AccessDenied",
    "NoSuchBucket",
    "SlowDown",
    "ECONNREFUSED",
    "ECONNRESET",
    "ENOTFOUND",
    "ETIMEDOUT",
    "P1001",
    "P2002",
    "P2021",
  ]);
  const allowedServiceReasons = new Set([
    "accessNotConfigured",
    "insufficientPermissions",
    "userRateLimitExceeded",
    "rateLimitExceeded",
    "domainPolicy",
    "forbidden",
  ]);
  const serviceCode =
    rawServiceCode && allowedServiceCodes.has(rawServiceCode)
      ? rawServiceCode
      : undefined;
  const serviceReason =
    typeof rawServiceReason === "string" &&
    allowedServiceReasons.has(rawServiceReason)
      ? rawServiceReason
      : undefined;

  if (serviceReason === "accessNotConfigured") {
    return { category: "gmail_api_not_enabled", httpStatus: status, serviceReason };
  }
  if (serviceReason === "insufficientPermissions") {
    return { category: "gmail_scope_insufficient", httpStatus: status, serviceReason };
  }
  if (serviceReason === "userRateLimitExceeded" || serviceReason === "rateLimitExceeded") {
    return { category: "gmail_rate_limited", httpStatus: status, serviceReason };
  }
  if (serviceReason === "domainPolicy") {
    return { category: "gmail_account_policy_denied", httpStatus: status, serviceReason };
  }
  if (serviceCode === "invalid_grant") {
    return { category: "refresh_token_rejected", httpStatus: status, serviceCode };
  }
  if (serviceCode === "invalid_client" || serviceCode === "unauthorized_client") {
    return { category: "oauth_client_rejected", httpStatus: status, serviceCode };
  }
  if (serviceCode === "insufficientPermissions" || googleStatus === 403) {
    return { category: "gmail_permission_denied", httpStatus: status, serviceCode };
  }
  if (
    serviceCode === "AccessDenied" ||
    (awsStatus !== undefined && awsStatus === 403)
  ) {
    return { category: "s3_access_denied", httpStatus: status, serviceCode };
  }
  if (serviceCode === "NoSuchBucket") {
    return { category: "s3_bucket_not_found", httpStatus: status, serviceCode };
  }
  if (serviceCode?.startsWith("P")) {
    return { category: "database_error", serviceCode };
  }
  if (serviceCode && ["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "ETIMEDOUT"].includes(serviceCode)) {
    return { category: "network_error", serviceCode };
  }
  if (status !== undefined) {
    return { category: "service_request_failed", httpStatus: status };
  }
  if (value.name === "Error" && error instanceof Error) {
    return { category: "configuration_or_sync_error" };
  }
  return { category: "service_error" };
}

function runSingleSync(task: () => Promise<PollSummary>): Promise<PollSummary> {
  if (activeSync) {
    return activeSync;
  }

  const currentSync = task().finally(() => {
    if (activeSync === currentSync) {
      activeSync = undefined;
    }
  });
  activeSync = currentSync;
  return currentSync;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function decodeBase64Url(value: string): Buffer {
  return Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function getHeader(
  headers: gmail_v1.Schema$MessagePartHeader[] | undefined,
  name: string,
): string {
  return (
    headers?.find((header) => header.name?.toLowerCase() === name.toLowerCase())
      ?.value ?? ""
  );
}

function collectMessageParts(
  part: gmail_v1.Schema$MessagePart,
  plainText: string[],
  htmlText: string[],
  attachments: gmail_v1.Schema$MessagePart[],
): void {
  if (part.filename) {
    if (part.body?.attachmentId || part.body?.data) {
      attachments.push(part);
    }
    return;
  }

  if (part.mimeType === "text/plain" && part.body?.data) {
    plainText.push(decodeBase64Url(part.body.data).toString("utf8"));
  } else if (part.mimeType === "text/html" && part.body?.data) {
    htmlText.push(decodeBase64Url(part.body.data).toString("utf8"));
  }

  for (const child of part.parts ?? []) {
    collectMessageParts(child, plainText, htmlText, attachments);
  }
}

function htmlToText(value: string): string {
  return value
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(div|p|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function createGmailClient(): gmail_v1.Gmail {
  const auth = new google.auth.OAuth2(
    requiredEnv("GOOGLE_CLIENT_ID"),
    requiredEnv("GOOGLE_CLIENT_SECRET"),
  );
  auth.setCredentials({ refresh_token: requiredEnv("GOOGLE_REFRESH_TOKEN") });
  return google.gmail({ version: "v1", auth });
}

async function getVerifiedGmailClient(): Promise<{
  gmail: gmail_v1.Gmail;
  connectedEmail: string;
  matches: boolean;
}> {
  const gmail = createGmailClient();
  const targetEmail = requiredEnv("GMAIL_USER_EMAIL").trim().toLowerCase();
  const profile = await gmail.users.getProfile({ userId: "me" });
  const connectedEmail = profile.data.emailAddress?.trim().toLowerCase();

  if (!connectedEmail) {
    throw new Error("Gmail did not return an email address for the authorized account");
  }

  return {
    gmail,
    connectedEmail,
    matches: connectedEmail === targetEmail,
  };
}

export async function verifyGmailConnection(): Promise<{
  connectedEmail: string;
  matches: boolean;
}> {
  const { connectedEmail, matches } = await getVerifiedGmailClient();
  return { connectedEmail, matches };
}

function createS3Client() {
  return new S3Client({
    region: process.env.AWS_REGION || "us-east-2",
    ...(process.env.S3_ENDPOINT
      ? {
          endpoint: process.env.S3_ENDPOINT,
          forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
        }
      : {}),
  });
}

export async function verifyS3Connection(): Promise<void> {
  const bucket = requiredEnv("S3_BUCKET");
  const s3 = createS3Client();

  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: "emails/.gmail-s3-agent-connection-check",
      Body: "Gmail S3 Agent S3 connection check",
      ContentType: "text/plain",
    }),
  );
}

async function downloadAttachment(
  gmail: gmail_v1.Gmail,
  messageId: string,
  part: gmail_v1.Schema$MessagePart,
): Promise<Buffer> {
  const data = part.body?.data;
  if (data) {
    return decodeBase64Url(data);
  }

  const attachmentId = part.body?.attachmentId;
  if (!attachmentId) {
    throw new Error(`Attachment "${part.filename}" has no downloadable content`);
  }

  const response = await gmail.users.messages.attachments.get({
    userId: "me",
    messageId,
    id: attachmentId,
  });
  if (!response.data.data) {
    throw new Error(`Gmail returned empty content for attachment "${part.filename}"`);
  }
  return decodeBase64Url(response.data.data);
}

async function uploadAttachments(
  gmail: gmail_v1.Gmail,
  s3: S3Client,
  bucket: string,
  messageId: string,
  parts: gmail_v1.Schema$MessagePart[],
  maxAttachmentBytes: number,
): Promise<StoredAttachment[]> {
  const stored: StoredAttachment[] = [];

  for (const part of parts) {
    const fileName = part.filename || "attachment";
    const bytes = await downloadAttachment(gmail, messageId, part);
    if (bytes.byteLength > maxAttachmentBytes) {
      throw new Error(
        `Attachment "${fileName}" exceeds MAX_ATTACHMENT_MB (${maxAttachmentBytes} bytes)`,
      );
    }

    const gmailAttachmentId =
      part.body?.attachmentId ?? `inline-${stored.length}`;
    const s3Key = `emails/${encodeURIComponent(messageId)}/${encodeURIComponent(gmailAttachmentId)}`;

    try {
      await s3.send(
        new PutObjectCommand({
        Bucket: bucket,
        Key: s3Key,
        Body: bytes,
        ContentType: part.mimeType || "application/octet-stream",
          IfNoneMatch: "*",
        }),
      );
    } catch (error) {
      const status =
        error && typeof error === "object" && "$metadata" in error
          ? (error as { $metadata?: { httpStatusCode?: number } }).$metadata
              ?.httpStatusCode
          : undefined;
      if (
        status !== 412 &&
        !(error instanceof Error && error.name === "PreconditionFailed")
      ) {
        throw error;
      }
    }

    stored.push({
      gmailAttachmentId,
      fileName,
      mimeType: part.mimeType || "application/octet-stream",
      size: bytes.byteLength,
      s3Key,
    });
  }

  return stored;
}

async function processMessage(
  gmail: gmail_v1.Gmail,
  s3: S3Client,
  bucket: string,
  gmailMessageId: string,
  maxAttachmentBytes: number,
): Promise<{
  processed: boolean;
  attachmentCount: number;
  emailId?: string;
  receivedAt?: Date;
}> {
  const existing = await prisma.email.findUnique({
    where: { gmailMessageId },
    select: { id: true, gmailLabels: true, receivedAt: true },
  });
  if (existing) {
    const response = await gmail.users.messages.get({
      userId: "me",
      id: gmailMessageId,
      format: "metadata",
    });
    const internalDate = Number(response.data.internalDate);
    if (!Number.isFinite(internalDate) || internalDate <= 0) {
      throw new Error("Gmail returned a missing or invalid internalDate");
    }
    const receivedAt = new Date(internalDate);
    const labels = [...(response.data.labelIds ?? [])].sort();
    if (
      labels.join("\0") !== [...existing.gmailLabels].sort().join("\0") ||
      receivedAt.getTime() !== existing.receivedAt.getTime()
    ) {
      await prisma.email.update({
        where: { id: existing.id },
        data: { gmailLabels: labels, receivedAt },
      });
    }
    return { processed: false, attachmentCount: 0 };
  }

  const response = await gmail.users.messages.get({
    userId: "me",
    id: gmailMessageId,
    format: "full",
  });
  const message = response.data;
  const payload = message.payload;
  if (!message.id || !message.threadId || !payload) {
    throw new Error(`Gmail returned an incomplete message for ${gmailMessageId}`);
  }

  const plainText: string[] = [];
  const htmlText: string[] = [];
  const attachmentParts: gmail_v1.Schema$MessagePart[] = [];
  collectMessageParts(payload, plainText, htmlText, attachmentParts);

  const attachments = await uploadAttachments(
    gmail,
    s3,
    bucket,
    message.id,
    attachmentParts,
    maxAttachmentBytes,
  );

  const internalDate = Number(message.internalDate);
  if (!Number.isFinite(internalDate) || internalDate <= 0) {
    throw new Error("Gmail returned a missing or invalid internalDate");
  }
  const receivedAt = new Date(internalDate);
  const bodyText =
    plainText.join("\n").trim() || htmlToText(htmlText.join("\n"));
  const bodyHtml = htmlText.join("\n").trim() || null;

  try {
    const savedEmail = await prisma.email.create({
      data: {
        gmailMessageId: message.id,
        gmailThreadId: message.threadId,
        sender: getHeader(payload.headers, "from"),
        recipients: getHeader(payload.headers, "to"),
        subject: getHeader(payload.headers, "subject") || "(no subject)",
        snippet: message.snippet ?? "",
        bodyText,
        bodyHtml,
        gmailLabels: [...(message.labelIds ?? [])].sort(),
        receivedAt,
        attachments: {
          create: attachments.map((attachment) => ({
            gmailAttachmentId: attachment.gmailAttachmentId,
            fileName: attachment.fileName,
            mimeType: attachment.mimeType,
            size: attachment.size,
            s3Key: attachment.s3Key,
          })),
        },
      },
    });
    return {
      processed: true,
      attachmentCount: attachments.length,
      emailId: savedEmail.id,
      receivedAt: savedEmail.receivedAt,
    };
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      return { processed: false, attachmentCount: 0 };
    }
    throw error;
  }

}

async function pollInboxOnce(): Promise<PollSummary> {
  const { gmail, matches, connectedEmail } = await getVerifiedGmailClient();
  if (!matches) {
    throw new Error(
      `Authorized Gmail account "${connectedEmail}" does not match GMAIL_USER_EMAIL`,
    );
  }

  const s3 = createS3Client();
  const bucket = requiredEnv("S3_BUCKET");
  const lookbackDays = Number(process.env.GMAIL_LOOKBACK_DAYS ?? "30");
  const maxAttachmentMb = Number(process.env.MAX_ATTACHMENT_MB ?? "25");

  if (!Number.isInteger(lookbackDays) || lookbackDays < 1) {
    throw new Error("GMAIL_LOOKBACK_DAYS must be a positive integer");
  }
  if (!Number.isFinite(maxAttachmentMb) || maxAttachmentMb <= 0) {
    throw new Error("MAX_ATTACHMENT_MB must be a positive number");
  }

  const startedAt = new Date();
  const savedState = await prisma.syncState.findUnique({
    where: { key: SYNC_STATE_KEY },
  });
  const lastSyncedAt = savedState
    ? new Date(savedState.value)
    : new Date(startedAt.getTime() - lookbackDays * 24 * 60 * 60 * 1000);
  if (!Number.isFinite(lastSyncedAt.getTime())) {
    throw new Error("Stored Gmail sync checkpoint is invalid");
  }

  const after = Math.floor(
    (lastSyncedAt.getTime() - OVERLAP_MS) / 1000,
  );
  const summary: PollSummary = {
    processedMessages: 0,
    skippedMessages: 0,
    uploadedAttachments: 0,
  };
  const maxAttachmentBytes = maxAttachmentMb * 1024 * 1024;
  let pageToken: string | undefined;

  do {
    const listResponse = await gmail.users.messages.list({
      userId: "me",
      q: `in:inbox after:${after}`,
      maxResults: 100,
      pageToken,
    });

    for (const listedMessage of listResponse.data.messages ?? []) {
      if (!listedMessage.id) {
        throw new Error("Gmail returned a message without an ID");
      }
      const result = await processMessage(
        gmail,
        s3,
        bucket,
        listedMessage.id,
        maxAttachmentBytes,
      );
      if (result.processed) {
        summary.processedMessages += 1;
        summary.uploadedAttachments += result.attachmentCount;
        // Do not auto-reply to the initial inbox backfill or messages already
        // present at the last checkpoint; automation applies to newly received mail.
        if (
          result.emailId &&
          result.receivedAt &&
          savedState &&
          result.receivedAt.getTime() > lastSyncedAt.getTime()
        ) {
          try {
            await processAutomaticReply(result.emailId);
          } catch (error) {
            console.error("[auto-reply] automatic_reply_generation_failed", {
              emailId: result.emailId,
              error: error instanceof Error ? error.message : "Unknown error",
            });
          }
        }
      } else {
        summary.skippedMessages += 1;
      }
      lastPollProgress = { ...summary };
    }
    pageToken = listResponse.data.nextPageToken ?? undefined;
  } while (pageToken);

  await prisma.syncState.upsert({
    where: { key: SYNC_STATE_KEY },
    create: { key: SYNC_STATE_KEY, value: startedAt.toISOString() },
    update: { value: startedAt.toISOString() },
  });

  return summary;
}

export function pollInbox(): Promise<PollSummary> {
  return runSingleSync(async () => {
    lastPollProgress = {
      processedMessages: 0,
      skippedMessages: 0,
      uploadedAttachments: 0,
    };
    const previous = await getGmailSyncStatus();
    const lastAttemptAt = new Date().toISOString();
    await writeSyncStatus({
      ...previous,
      status: "running",
      lastAttemptAt,
      errorMessage: null,
    });

    try {
      const result = await pollInboxOnce();
      await writeSyncStatus({
        status: "success",
        lastAttemptAt,
        lastSuccessfulAt: new Date().toISOString(),
        ...result,
        errorMessage: null,
      });
      return result;
    } catch (error) {
      const diagnostic = getSafeSyncDiagnostic(error);
      try {
        await writeSyncStatus({
          status: "error",
          lastAttemptAt,
          lastSuccessfulAt: previous.lastSuccessfulAt,
          ...lastPollProgress,
          errorMessage: syncErrorMessage(diagnostic),
        });
      } catch (statusError) {
        console.error(
          "[gmail-sync] status_write_failed",
          getSafeSyncDiagnostic(statusError),
        );
      }
      throw error;
    }
  });
}

async function syncRecentInboxBatchOnce(): Promise<PollSummary> {
  const { gmail, matches, connectedEmail } = await getVerifiedGmailClient();
  if (!matches) {
    throw new Error(
      `Authorized Gmail account "${connectedEmail}" does not match GMAIL_USER_EMAIL`,
    );
  }

  const maxAttachmentMb = Number(process.env.MAX_ATTACHMENT_MB ?? "25");
  if (!Number.isFinite(maxAttachmentMb) || maxAttachmentMb <= 0) {
    throw new Error("MAX_ATTACHMENT_MB must be a positive number");
  }

  const s3 = createS3Client();
  const bucket = requiredEnv("S3_BUCKET");
  const maxAttachmentBytes = maxAttachmentMb * 1024 * 1024;
  const listResponse = await gmail.users.messages.list({
    userId: "me",
    q: "in:inbox",
    maxResults: 5,
  });
  const summary: PollSummary = {
    processedMessages: 0,
    skippedMessages: 0,
    uploadedAttachments: 0,
  };

  for (const listedMessage of listResponse.data.messages ?? []) {
    if (!listedMessage.id) {
      throw new Error("Gmail returned a message without an ID");
    }

    const result = await processMessage(
      gmail,
      s3,
      bucket,
      listedMessage.id,
      maxAttachmentBytes,
    );
    if (result.processed) {
      summary.processedMessages += 1;
      summary.uploadedAttachments += result.attachmentCount;
    } else {
      summary.skippedMessages += 1;
    }
  }

  return summary;
}

export function syncRecentInboxBatch(): Promise<PollSummary> {
  return runSingleSync(syncRecentInboxBatchOnce);
}

async function getHistoryState(): Promise<HistorySyncState> {
  const stored = await prisma.syncState.findUnique({
    where: { key: HISTORY_SYNC_STATE_KEY },
  });
  if (!stored) {
    return {
      status: "not_started",
      nextPageToken: null,
      processedMessages: 0,
      skippedMessages: 0,
      uploadedAttachments: 0,
    };
  }

  try {
    const parsed = JSON.parse(stored.value) as HistorySyncState;
    if (
      !["running", "completed"].includes(parsed.status) ||
      !Number.isSafeInteger(parsed.processedMessages) ||
      !Number.isSafeInteger(parsed.skippedMessages) ||
      !Number.isSafeInteger(parsed.uploadedAttachments) ||
      (parsed.nextPageToken !== null && typeof parsed.nextPageToken !== "string")
    ) {
      throw new Error("Invalid history sync state");
    }
    return parsed;
  } catch {
    throw new Error("Stored historical Gmail sync state is invalid");
  }
}

export async function getHistoricalSyncState(): Promise<HistorySyncState> {
  return getHistoryState();
}

async function syncHistoricalBatchOnce(): Promise<HistorySyncState> {
  const { gmail, matches, connectedEmail } = await getVerifiedGmailClient();
  if (!matches) {
    throw new Error(
      `Authorized Gmail account "${connectedEmail}" does not match GMAIL_USER_EMAIL`,
    );
  }

  const state = await getHistoryState();
  if (state.status === "completed") {
    return state;
  }

  const s3 = createS3Client();
  const bucket = requiredEnv("S3_BUCKET");
  const maxAttachmentMb = Number(process.env.MAX_ATTACHMENT_MB ?? "25");
  if (!Number.isFinite(maxAttachmentMb) || maxAttachmentMb <= 0) {
    throw new Error("MAX_ATTACHMENT_MB must be a positive number");
  }

  const page = await gmail.users.messages.list({
    userId: "me",
    includeSpamTrash: true,
    maxResults: 100,
    pageToken: state.nextPageToken ?? undefined,
  });
  const pageSummary: PollSummary = {
    processedMessages: 0,
    skippedMessages: 0,
    uploadedAttachments: 0,
  };

  for (const listedMessage of page.data.messages ?? []) {
    if (!listedMessage.id) {
      throw new Error("Gmail returned a message without an ID");
    }
    const result = await processMessage(
      gmail,
      s3,
      bucket,
      listedMessage.id,
      maxAttachmentMb * 1024 * 1024,
    );
    if (result.processed) {
      pageSummary.processedMessages += 1;
      pageSummary.uploadedAttachments += result.attachmentCount;
    } else {
      pageSummary.skippedMessages += 1;
    }
  }

  const nextState: HistorySyncState = {
    status: page.data.nextPageToken ? "running" : "completed",
    nextPageToken: page.data.nextPageToken ?? null,
    processedMessages: state.processedMessages + pageSummary.processedMessages,
    skippedMessages: state.skippedMessages + pageSummary.skippedMessages,
    uploadedAttachments: state.uploadedAttachments + pageSummary.uploadedAttachments,
  };

  await prisma.syncState.upsert({
    where: { key: HISTORY_SYNC_STATE_KEY },
    create: { key: HISTORY_SYNC_STATE_KEY, value: JSON.stringify(nextState) },
    update: { value: JSON.stringify(nextState) },
  });

  return nextState;
}

export function syncHistoricalBatch(): Promise<HistorySyncState> {
  return syncHistoricalBatchOnce();
}

export async function restartHistoricalSync(): Promise<HistorySyncState> {
  const initialState: HistorySyncState = {
    status: "running",
    nextPageToken: null,
    processedMessages: 0,
    skippedMessages: 0,
    uploadedAttachments: 0,
  };
  await prisma.syncState.upsert({
    where: { key: HISTORY_SYNC_STATE_KEY },
    create: { key: HISTORY_SYNC_STATE_KEY, value: JSON.stringify(initialState) },
    update: { value: JSON.stringify(initialState) },
  });
  return initialState;
}

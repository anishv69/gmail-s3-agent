import { GetObjectCommand } from "@aws-sdk/client-s3";
import { Client } from "pg";
import type { AiIndexState } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  getAiDatabase,
  markDocumentFailed,
  replaceDocumentChunks,
} from "@/lib/ai/database";
import {
  extractDocumentText,
  MAX_DOCUMENT_BYTES,
  MAX_EXTRACTED_CHARACTERS,
} from "@/lib/ai/extract-document";
import { hashIndexableContent, indexExtractedDocument } from "@/lib/ai/index-document";
import { createEmbeddings } from "@/lib/ai/openai";
import type { AiSourceType } from "@/lib/ai/types";
import { createS3Client, getS3Bucket } from "@/lib/s3-client";

const AI_LOCK_KEY_1 = 1196443988;
const AI_LOCK_KEY_2 = 1095782473;
const DEFAULT_BATCH_SIZE = 1;
const MAX_BATCH_SIZE = 1;

type IndexCandidate = {
  sourceType: AiSourceType;
  sourceId: string;
  emailId: string;
  s3Key: string | null;
  gmailMessageId: string;
  title: string;
  sender: string | null;
  receivedAt: Date | null;
  mimeType: string;
  content: string;
  fileName: string;
};

export type AiIndexProgress = {
  status: string;
  phase: string;
  processedDocuments: number;
  skippedDocuments: number;
  failedDocuments: number;
  totalSources: number;
  indexedSources: number;
  pendingSources: number;
  startedAt: string | null;
  completedAt: string | null;
};

function getSafeFailureCode(error: unknown): string {
  if (!(error instanceof Error)) return "indexing_failed";
  const code = error.message;
  if (
    [
      "document_too_large",
      "empty_document",
      "invalid_docx_document",
      "invalid_json_document",
      "no_extractable_text",
      "unsupported_document_type",
    ].includes(code)
  ) {
    return code;
  }
  if (/403|access.?denied/i.test(code)) return "s3_access_denied";
  if (/404|nosuchkey/i.test(code)) return "s3_object_missing";
  if (/openai|embedding|api key|rate limit/i.test(code)) return "embedding_provider_failed";
  return "indexing_failed";
}

async function readS3Object(key: string): Promise<Uint8Array> {
  const result = await createS3Client().send(
    new GetObjectCommand({ Bucket: getS3Bucket(), Key: key }),
  );
  if (!result.Body) throw new Error("empty_document");
  if (result.ContentLength !== undefined && result.ContentLength > MAX_DOCUMENT_BYTES) {
    throw new Error("document_too_large");
  }
  const body = result.Body as AsyncIterable<Uint8Array>;
  const parts: Uint8Array[] = [];
  let length = 0;
  for await (const part of body) {
    length += part.byteLength;
    if (length > MAX_DOCUMENT_BYTES) throw new Error("document_too_large");
    parts.push(part);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return bytes;
}

async function createEmailCandidate(afterId: string | null): Promise<IndexCandidate[]> {
  const emails = await prisma.email.findMany({
    ...(afterId ? { where: { id: { gt: afterId } } } : {}),
    orderBy: { id: "asc" },
    take: 1,
    select: {
      id: true,
      gmailMessageId: true,
      sender: true,
      recipients: true,
      subject: true,
      bodyText: true,
      receivedAt: true,
    },
  });
  return emails.map((email) => ({
    sourceType: "EMAIL",
    sourceId: email.id,
    emailId: email.id,
    s3Key: null,
    gmailMessageId: email.gmailMessageId,
    title: email.subject || "(no subject)",
    sender: email.sender,
    receivedAt: email.receivedAt,
    mimeType: "message/rfc822",
    fileName: email.subject || "email",
    content: [
      `From: ${email.sender}`,
      `To: ${email.recipients}`,
      `Subject: ${email.subject}`,
      `Received: ${email.receivedAt.toISOString()}`,
      "",
      email.bodyText,
    ].join("\n"),
  }));
}

async function createAttachmentCandidate(
  afterId: string | null,
): Promise<IndexCandidate[]> {
  const attachments = await prisma.attachment.findMany({
    ...(afterId ? { where: { id: { gt: afterId } } } : {}),
    orderBy: { id: "asc" },
    take: 1,
    select: {
      id: true,
      s3Key: true,
      fileName: true,
      mimeType: true,
      email: {
        select: {
          id: true,
          gmailMessageId: true,
          subject: true,
          sender: true,
          receivedAt: true,
        },
      },
    },
  });
  const attachment = attachments[0];
  if (!attachment) return [];
  return [
    {
      sourceType: "ATTACHMENT",
      sourceId: attachment.id,
      emailId: attachment.email.id,
      s3Key: attachment.s3Key,
      gmailMessageId: attachment.email.gmailMessageId,
      title: attachment.fileName,
      sender: attachment.email.sender,
      receivedAt: attachment.email.receivedAt,
      mimeType: attachment.mimeType,
      fileName: attachment.fileName,
      content: "",
    },
  ];
}

async function indexCandidate(candidate: IndexCandidate): Promise<"indexed" | "skipped"> {
  let content = candidate.content;
  let mimeType = candidate.mimeType;
  if (candidate.sourceType === "ATTACHMENT") {
    if (!candidate.s3Key) throw new Error("s3_object_missing");
    const extracted = await extractDocumentText(
      await readS3Object(candidate.s3Key),
      candidate.mimeType,
      candidate.fileName,
    );
    if (extracted.truncated) throw new Error("document_too_large");
    content = extracted.text;
    mimeType = extracted.mimeType;
  } else if (content.length > MAX_EXTRACTED_CHARACTERS) {
    throw new Error("document_too_large");
  }
  return indexExtractedDocument(
    { ...candidate, mimeType, text: content },
    {
      findExisting: async (sourceType, sourceId) => {
        const existing = await prisma.aiDocument.findUnique({
          where: { sourceType_sourceId: { sourceType, sourceId } },
          select: { contentHash: true, indexStatus: true },
        });
        return existing;
      },
      embed: createEmbeddings,
      store: async ({ document, contentHash, chunks, embeddings }) =>
        replaceDocumentChunks({
          sourceType: document.sourceType,
          sourceId: document.sourceId,
          emailId: document.emailId,
          s3Key: document.s3Key,
          gmailMessageId: document.gmailMessageId,
          title: document.title,
          sender: document.sender,
          receivedAt: document.receivedAt,
          mimeType: document.mimeType,
          contentHash,
          chunks,
          embeddings,
        }),
  });
}

async function markCandidateFailed(
  candidate: IndexCandidate,
  error: unknown,
): Promise<void> {
  const connection = await getAiDatabase().connect();
  try {
    await markDocumentFailed(connection, {
      sourceType: candidate.sourceType,
      sourceId: candidate.sourceId,
      emailId: candidate.emailId,
      s3Key: candidate.s3Key,
      gmailMessageId: candidate.gmailMessageId,
      title: candidate.title,
      sender: candidate.sender,
      receivedAt: candidate.receivedAt,
      mimeType: candidate.mimeType,
      contentHash: hashIndexableContent({
        title: candidate.title,
        sender: candidate.sender,
        receivedAt: candidate.receivedAt,
        mimeType: candidate.mimeType,
        text: candidate.content,
      }),
      failureCode: getSafeFailureCode(error),
    });
  } finally {
    connection.release();
  }
}

export async function getAiIndexProgress(): Promise<AiIndexProgress> {
  const [emailCount, attachmentCount, groups, state] = await Promise.all([
    prisma.email.count(),
    prisma.attachment.count(),
    prisma.aiDocument.groupBy({
      by: ["indexStatus"],
      _count: { _all: true },
    }),
    prisma.aiIndexState.findUnique({ where: { key: "default" } }),
  ]);
  const indexedSources = groups
    .filter((group) => group.indexStatus === "INDEXED")
    .reduce((sum, group) => sum + group._count._all, 0);
  return {
    status: state?.status ?? "idle",
    phase: state?.phase ?? "EMAIL",
    processedDocuments: state?.processedDocuments ?? 0,
    skippedDocuments: state?.skippedDocuments ?? 0,
    failedDocuments: state?.failedDocuments ?? 0,
    totalSources: emailCount + attachmentCount,
    indexedSources,
    pendingSources: Math.max(0, emailCount + attachmentCount - indexedSources),
    startedAt: state?.startedAt?.toISOString() ?? null,
    completedAt: state?.completedAt?.toISOString() ?? null,
  };
}

export async function startAiIndexing(): Promise<AiIndexProgress> {
  const current = await prisma.aiIndexState.findUnique({
    where: { key: "default" },
    select: { status: true },
  });
  if (current?.status === "running") {
    return getAiIndexProgress();
  }
  await prisma.aiIndexState.upsert({
    where: { key: "default" },
    create: {
      key: "default",
      status: "running",
      phase: "EMAIL",
      cursorId: null,
      processedDocuments: 0,
      skippedDocuments: 0,
      failedDocuments: 0,
      startedAt: new Date(),
      completedAt: null,
    },
    update: {
      status: "running",
      phase: "EMAIL",
      cursorId: null,
      processedDocuments: 0,
      skippedDocuments: 0,
      failedDocuments: 0,
      startedAt: new Date(),
      completedAt: null,
    },
  });
  return getAiIndexProgress();
}

export async function runAiIndexBatch(requestedLimit?: number): Promise<AiIndexProgress> {
  const limit =
    Number.isSafeInteger(requestedLimit) && requestedLimit
      ? Math.min(MAX_BATCH_SIZE, Math.max(1, requestedLimit))
      : DEFAULT_BATCH_SIZE;
  let state: AiIndexState | null = await prisma.aiIndexState.findUnique({
    where: { key: "default" },
  });
  if (!state || state.status !== "running") {
    return getAiIndexProgress();
  }

  let remaining = limit;
  while (remaining > 0 && state.status === "running") {
    const candidates: IndexCandidate[] =
      state.phase === "EMAIL"
        ? await createEmailCandidate(state.cursorId)
        : await createAttachmentCandidate(state.cursorId);
    if (!candidates.length) {
      if (state.phase === "EMAIL") {
        state = await prisma.aiIndexState.update({
          where: { key: "default" },
          data: { phase: "ATTACHMENT", cursorId: null },
        });
        continue;
      }
      state = await prisma.aiIndexState.update({
        where: { key: "default" },
        data: { status: "completed", cursorId: null, completedAt: new Date() },
      });
      break;
    }

    const candidate: IndexCandidate | undefined = candidates[0];
    if (!candidate) break;
    let processedDocuments: number = state.processedDocuments;
    let skippedDocuments: number = state.skippedDocuments;
    let failedDocuments: number = state.failedDocuments;
    try {
      const result = await indexCandidate(candidate);
      if (result === "indexed") processedDocuments += 1;
      else skippedDocuments += 1;
    } catch (error) {
      await markCandidateFailed(candidate, error);
      failedDocuments += 1;
      console.error("[ai-index] document_failed", {
        sourceType: candidate.sourceType,
        failureCode: getSafeFailureCode(error),
      });
    }
    state = await prisma.aiIndexState.update({
      where: { key: "default" },
      data: {
        cursorId: candidate.sourceId,
        processedDocuments,
        skippedDocuments,
        failedDocuments,
      },
    });
    remaining -= 1;
  }
  return getAiIndexProgress();
}

export async function withAiIndexLock<T>(
  task: () => Promise<T>,
): Promise<{ acquired: false } | { acquired: true; result: T }> {
  const connectionString =
    process.env.DIRECT_URL?.trim() ??
    (process.env.NODE_ENV === "production" ? undefined : process.env.DATABASE_URL);
  if (!connectionString) {
    throw new Error("DIRECT_URL is required for AI indexing in production.");
  }
  const client = new Client({
    connectionString,
    application_name: "gmail-s3-agent-ai-index-lock",
    connectionTimeoutMillis: 10_000,
    keepAlive: true,
  });
  await client.connect();
  let acquired = false;
  try {
    const result = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock($1, $2) AS locked",
      [AI_LOCK_KEY_1, AI_LOCK_KEY_2],
    );
    acquired = result.rows[0]?.locked === true;
    if (!acquired) return { acquired: false };
    return { acquired: true, result: await task() };
  } finally {
    try {
      if (acquired) {
        await client.query("SELECT pg_advisory_unlock($1, $2)", [
          AI_LOCK_KEY_1,
          AI_LOCK_KEY_2,
        ]);
      }
    } finally {
      await client.end();
    }
  }
}

export const AI_INDEX_BATCH_LIMIT = MAX_BATCH_SIZE;

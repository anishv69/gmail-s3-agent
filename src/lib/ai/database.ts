import { Pool, type PoolClient } from "pg";
import type { AiSourceType, RetrievedChunk } from "@/lib/ai/types";

type AiDatabaseGlobal = typeof globalThis & {
  aiVectorPool?: Pool;
};

const databaseGlobal = globalThis as AiDatabaseGlobal;

export function getAiDatabase(): Pool {
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) {
    throw new Error("DATABASE_URL is not configured on the server.");
  }
  databaseGlobal.aiVectorPool ??= new Pool({
    connectionString,
    max: 3,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 10_000,
    application_name: "gmail-s3-agent-ai",
  });
  return databaseGlobal.aiVectorPool;
}

export async function replaceDocumentChunks(
  input: {
    sourceType: AiSourceType;
    sourceId: string;
    emailId: string;
    s3Key: string | null;
    gmailMessageId: string;
    title: string;
    sender: string | null;
    receivedAt: Date | null;
    mimeType: string;
    contentHash: string;
    chunks: string[];
    embeddings: number[][];
  },
): Promise<void> {
  if (input.chunks.length !== input.embeddings.length) {
    throw new Error("Chunk and embedding counts do not match.");
  }

  const pool = getAiDatabase();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const document = await client.query<{ id: string }>(
      `INSERT INTO "AiDocument" (
        "id", "sourceType", "sourceId", "emailId", "s3Key", "gmailMessageId",
        "title", "sender", "receivedAt", "mimeType", "contentHash",
        "indexStatus", "failureCode", "indexedAt", "createdAt", "updatedAt"
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
        'INDEXED', NULL, NOW(), NOW(), NOW()
      )
      ON CONFLICT ("sourceType", "sourceId") DO UPDATE SET
        "emailId" = EXCLUDED."emailId",
        "s3Key" = EXCLUDED."s3Key",
        "gmailMessageId" = EXCLUDED."gmailMessageId",
        "title" = EXCLUDED."title",
        "sender" = EXCLUDED."sender",
        "receivedAt" = EXCLUDED."receivedAt",
        "mimeType" = EXCLUDED."mimeType",
        "contentHash" = EXCLUDED."contentHash",
        "indexStatus" = 'INDEXED',
        "failureCode" = NULL,
        "indexedAt" = NOW(),
        "updatedAt" = NOW()
      RETURNING "id"`,
      [
        crypto.randomUUID(),
        input.sourceType,
        input.sourceId,
        input.emailId,
        input.s3Key,
        input.gmailMessageId,
        input.title,
        input.sender,
        input.receivedAt,
        input.mimeType,
        input.contentHash,
      ],
    );
    const documentId = document.rows[0]?.id;
    if (!documentId) throw new Error("Unable to store indexed document metadata.");

    await client.query(`DELETE FROM "AiDocumentChunk" WHERE "documentId" = $1`, [
      documentId,
    ]);
    for (let index = 0; index < input.chunks.length; index += 1) {
      const embedding = input.embeddings[index];
      if (!embedding || embedding.length !== 1536) {
        throw new Error("Invalid embedding dimensions.");
      }
      const vector = `[${embedding.join(",")}]`;
      await client.query(
        `INSERT INTO "AiDocumentChunk" (
          "id", "documentId", "chunkIndex", "content", "embedding", "createdAt"
        ) VALUES ($1, $2, $3, $4, $5::vector, NOW())`,
        [crypto.randomUUID(), documentId, index, input.chunks[index], vector],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function findSimilarChunks(
  embedding: number[],
  limit: number,
  minimumScore: number,
  receivedRange?: { start: Date; end: Date },
): Promise<RetrievedChunk[]> {
  if (embedding.length !== 1536 || embedding.some((value) => !Number.isFinite(value))) {
    throw new Error("Invalid query embedding.");
  }
  const vector = `[${embedding.join(",")}]`;
  const result = await getAiDatabase().query<{
    id: string;
    documentId: string;
    content: string;
    chunkIndex: number;
    sourceType: AiSourceType;
    sourceId: string;
    title: string;
    sender: string | null;
    receivedAt: Date | null;
    gmailMessageId: string | null;
    attachmentId: string | null;
    mimeType: string;
    score: number | string;
  }>(
    `SELECT
       c."id", c."documentId", c."content", c."chunkIndex",
       d."sourceType", d."sourceId", d."title", d."sender", d."receivedAt",
       d."gmailMessageId",
       CASE WHEN d."sourceType" = 'ATTACHMENT' THEN d."sourceId" ELSE NULL END AS "attachmentId",
       d."mimeType",
       1 - (c."embedding" <=> $1::vector) AS "score"
     FROM "AiDocumentChunk" c
     JOIN "AiDocument" d ON d."id" = c."documentId"
     WHERE d."indexStatus" = 'INDEXED'
       AND 1 - (c."embedding" <=> $1::vector) >= $2
       AND ($4::timestamptz IS NULL OR d."receivedAt" >= $4::timestamptz)
       AND ($5::timestamptz IS NULL OR d."receivedAt" < $5::timestamptz)
     ORDER BY c."embedding" <=> $1::vector
     LIMIT $3`,
    [vector, minimumScore, limit, receivedRange?.start ?? null, receivedRange?.end ?? null],
  );
  return result.rows.map((row) => ({
    ...row,
    score: Number(row.score),
  }));
}

export async function findRecentChunks(
  limit: number,
  receivedRange?: { start: Date; end: Date },
  sourceType?: AiSourceType,
): Promise<RetrievedChunk[]> {
  const result = await getAiDatabase().query<{
    id: string;
    documentId: string;
    content: string;
    chunkIndex: number;
    sourceType: AiSourceType;
    sourceId: string;
    title: string;
    sender: string | null;
    receivedAt: Date | null;
    gmailMessageId: string | null;
    attachmentId: string | null;
    mimeType: string;
  }>(
    `SELECT
       c."id", c."documentId", c."content", c."chunkIndex",
       d."sourceType", d."sourceId", d."title", d."sender", d."receivedAt",
       d."gmailMessageId",
       CASE WHEN d."sourceType" = 'ATTACHMENT' THEN d."sourceId" ELSE NULL END AS "attachmentId",
       d."mimeType"
     FROM "AiDocumentChunk" c
     JOIN "AiDocument" d ON d."id" = c."documentId"
     WHERE d."indexStatus" = 'INDEXED'
       AND c."chunkIndex" = 0
       AND d."receivedAt" IS NOT NULL
       AND ($1::timestamptz IS NULL OR d."receivedAt" >= $1::timestamptz)
       AND ($2::timestamptz IS NULL OR d."receivedAt" < $2::timestamptz)
       AND ($4::text IS NULL OR d."sourceType" = $4::text)
     ORDER BY d."receivedAt" DESC, d."id" DESC
     LIMIT $3`,
    [receivedRange?.start ?? null, receivedRange?.end ?? null, limit, sourceType ?? null],
  );
  return result.rows.map((row) => ({ ...row, score: 1 }));
}

export async function findAttachmentCatalog(limit = 20): Promise<RetrievedChunk[]> {
  const safeLimit = Math.max(1, Math.min(20, Math.floor(limit)));
  const result = await getAiDatabase().query<{
    id: string;
    title: string;
    sender: string;
    receivedAt: Date;
    gmailMessageId: string;
    mimeType: string;
    catalogTotal: number;
  }>(
    `SELECT
       a."id",
       a."fileName" AS "title",
       e."sender",
       e."receivedAt",
       e."gmailMessageId",
       a."mimeType",
       COUNT(*) OVER()::int AS "catalogTotal"
     FROM "Attachment" a
     JOIN "Email" e ON e."id" = a."emailId"
     ORDER BY e."receivedAt" DESC, a."id" ASC
     LIMIT $1`,
    [safeLimit],
  );
  const total = result.rows[0]?.catalogTotal ?? 0;
  return result.rows.map((row, index) => ({
    id: `catalog-${row.id}`,
    documentId: `catalog-${row.id}`,
    content: [
      `Private S3 attachment catalog entry ${index + 1} of ${total}.`,
      `Filename: ${row.title}`,
      `MIME type: ${row.mimeType}`,
      `Email sender: ${row.sender}`,
      `Email received: ${row.receivedAt.toISOString()}`,
      total > safeLimit
        ? `This is a partial catalog; showing the newest ${safeLimit} of ${total} attachments.`
        : `This catalog contains all ${total} attachments.`,
    ].join("\n"),
    chunkIndex: 0,
    sourceType: "ATTACHMENT",
    sourceId: row.id,
    title: row.title,
    sender: row.sender,
    receivedAt: row.receivedAt,
    gmailMessageId: row.gmailMessageId,
    attachmentId: row.id,
    mimeType: row.mimeType,
    score: 1,
  }));
}

export async function findRecentEmails(
  limit: number,
  receivedRange?: { start: Date; end: Date },
): Promise<RetrievedChunk[]> {
  const result = await getAiDatabase().query<{
    id: string;
    sender: string | null;
    receivedAt: Date;
    gmailMessageId: string;
    subject: string;
    snippet: string;
  }>(
    `SELECT
       e."id",
       e."sender",
       e."receivedAt",
       e."gmailMessageId",
       e."subject",
       e."snippet"
     FROM "Email" e
     WHERE e."receivedAt" IS NOT NULL
       AND e."sender" IS NOT NULL
       AND ($1::timestamptz IS NULL OR e."receivedAt" >= $1::timestamptz)
       AND ($2::timestamptz IS NULL OR e."receivedAt" < $2::timestamptz)
     ORDER BY e."receivedAt" DESC, e."id" DESC
     LIMIT $3`,
    [receivedRange?.start ?? null, receivedRange?.end ?? null, limit],
  );

  return result.rows.map((row) => ({
    id: `email-${row.id}`,
    documentId: `email-${row.id}`,
    content: `Email from ${row.sender || "unknown"}:\nSubject: ${row.subject}\n\n${row.snippet}`,
    chunkIndex: 0,
    sourceType: "EMAIL" as const,
    sourceId: row.id,
    title: row.subject,
    sender: row.sender,
    receivedAt: row.receivedAt,
    gmailMessageId: row.gmailMessageId,
    attachmentId: null,
    mimeType: "message/rfc822",
    score: 1,
  }));
}

export async function markDocumentFailed(
  client: PoolClient,
  input: {
    sourceType: AiSourceType;
    sourceId: string;
    emailId: string;
    s3Key: string | null;
    gmailMessageId: string;
    title: string;
    sender: string | null;
    receivedAt: Date | null;
    mimeType: string;
    contentHash: string;
    failureCode: string;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO "AiDocument" (
      "id", "sourceType", "sourceId", "emailId", "s3Key", "gmailMessageId",
      "title", "sender", "receivedAt", "mimeType", "contentHash",
      "indexStatus", "failureCode", "createdAt", "updatedAt"
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'FAILED', $12, NOW(), NOW())
    ON CONFLICT ("sourceType", "sourceId") DO UPDATE SET
      "emailId" = EXCLUDED."emailId",
      "s3Key" = EXCLUDED."s3Key",
      "gmailMessageId" = EXCLUDED."gmailMessageId",
      "title" = EXCLUDED."title",
      "sender" = EXCLUDED."sender",
      "receivedAt" = EXCLUDED."receivedAt",
      "mimeType" = EXCLUDED."mimeType",
      "contentHash" = EXCLUDED."contentHash",
      "indexStatus" = 'FAILED',
      "failureCode" = EXCLUDED."failureCode",
      "updatedAt" = NOW()`,
    [
      crypto.randomUUID(),
      input.sourceType,
      input.sourceId,
      input.emailId,
      input.s3Key,
      input.gmailMessageId,
      input.title,
      input.sender,
      input.receivedAt,
      input.mimeType,
      input.contentHash,
      input.failureCode,
    ],
  );
}

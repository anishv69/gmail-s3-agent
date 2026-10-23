CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE "AiDocument" (
    "id" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "emailId" TEXT,
    "s3Key" TEXT,
    "gmailMessageId" TEXT,
    "title" TEXT NOT NULL,
    "sender" TEXT,
    "receivedAt" TIMESTAMPTZ(3),
    "mimeType" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "indexStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "failureCode" TEXT,
    "indexedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiDocument_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AiDocumentChunk" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "chunkIndex" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "embedding" vector(1536) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiDocumentChunk_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AiIndexState" (
    "key" TEXT NOT NULL DEFAULT 'default',
    "status" TEXT NOT NULL DEFAULT 'idle',
    "phase" TEXT NOT NULL DEFAULT 'EMAIL',
    "cursorId" TEXT,
    "processedDocuments" INTEGER NOT NULL DEFAULT 0,
    "skippedDocuments" INTEGER NOT NULL DEFAULT 0,
    "failedDocuments" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMPTZ(3),
    "completedAt" TIMESTAMPTZ(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiIndexState_pkey" PRIMARY KEY ("key")
);

CREATE UNIQUE INDEX "AiDocument_sourceType_sourceId_key" ON "AiDocument"("sourceType", "sourceId");
CREATE INDEX "AiDocument_indexStatus_idx" ON "AiDocument"("indexStatus");
CREATE INDEX "AiDocument_emailId_idx" ON "AiDocument"("emailId");
CREATE INDEX "AiDocument_receivedAt_idx" ON "AiDocument"("receivedAt");
CREATE UNIQUE INDEX "AiDocumentChunk_documentId_chunkIndex_key" ON "AiDocumentChunk"("documentId", "chunkIndex");
CREATE INDEX "AiDocumentChunk_documentId_idx" ON "AiDocumentChunk"("documentId");
CREATE INDEX "AiDocumentChunk_embedding_hnsw_idx" ON "AiDocumentChunk" USING hnsw ("embedding" vector_cosine_ops);

ALTER TABLE "AiDocument" ADD CONSTRAINT "AiDocument_emailId_fkey"
    FOREIGN KEY ("emailId") REFERENCES "Email"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AiDocumentChunk" ADD CONSTRAINT "AiDocumentChunk_documentId_fkey"
    FOREIGN KEY ("documentId") REFERENCES "AiDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- DropIndex
DROP INDEX "AiDocumentChunk_embedding_hnsw_idx";

-- CreateTable
CREATE TABLE "AutoReplySettings" (
    "id" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "autoSendToKnown" BOOLEAN NOT NULL DEFAULT false,
    "responseTemplate" TEXT,
    "responseTone" TEXT NOT NULL DEFAULT 'professional',
    "excludeSenders" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "excludeSubjects" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AutoReplySettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutoReply" (
    "id" TEXT NOT NULL,
    "emailId" TEXT NOT NULL,
    "settingsId" TEXT NOT NULL,
    "originalFrom" TEXT NOT NULL,
    "originalTo" TEXT NOT NULL,
    "originalSubject" TEXT NOT NULL,
    "generatedReply" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.7,
    "shouldAutoSend" BOOLEAN NOT NULL DEFAULT false,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AutoReply_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AutoReplySettings_enabled_idx" ON "AutoReplySettings"("enabled");

-- CreateIndex
CREATE INDEX "AutoReply_emailId_idx" ON "AutoReply"("emailId");

-- CreateIndex
CREATE INDEX "AutoReply_status_idx" ON "AutoReply"("status");

-- CreateIndex
CREATE INDEX "AutoReply_settingsId_idx" ON "AutoReply"("settingsId");

-- CreateIndex
CREATE INDEX "AutoReply_createdAt_idx" ON "AutoReply"("createdAt");

-- AddForeignKey
ALTER TABLE "AutoReply" ADD CONSTRAINT "AutoReply_settingsId_fkey" FOREIGN KEY ("settingsId") REFERENCES "AutoReplySettings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

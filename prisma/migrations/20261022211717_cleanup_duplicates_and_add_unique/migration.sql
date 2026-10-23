-- Delete duplicates: keep only the latest auto-reply for each (emailId, settingsId) combination
DELETE FROM "AutoReply"
WHERE id NOT IN (
  SELECT DISTINCT ON ("emailId", "settingsId") id
  FROM "AutoReply"
  ORDER BY "emailId", "settingsId", "createdAt" DESC
);

-- Add unique constraint on (emailId, settingsId)
ALTER TABLE "AutoReply"
ADD CONSTRAINT "AutoReply_emailId_settingsId_unique"
UNIQUE ("emailId", "settingsId");

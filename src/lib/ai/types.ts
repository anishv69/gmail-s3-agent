export type AiSourceType = "EMAIL" | "ATTACHMENT";

export type AiSourceReference = {
  citation: string;
  sourceType: AiSourceType;
  title: string;
  sender: string | null;
  receivedAt: string | null;
  gmailMessageId: string | null;
  attachmentId: string | null;
  mimeType: string;
  score: number;
};

export type RetrievedChunk = {
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
  score: number;
};

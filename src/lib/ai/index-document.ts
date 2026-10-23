import { createHash } from "node:crypto";
import { chunkText } from "@/lib/ai/chunking";
import type { AiSourceType } from "@/lib/ai/types";

export type IndexDocumentInput = {
  sourceType: AiSourceType;
  sourceId: string;
  emailId: string;
  s3Key: string | null;
  gmailMessageId: string;
  title: string;
  sender: string | null;
  receivedAt: Date | null;
  mimeType: string;
  text: string;
};

export type ExistingIndex = {
  contentHash: string;
  indexStatus: string;
};

export type IndexDocumentDependencies = {
  findExisting: (sourceType: AiSourceType, sourceId: string) => Promise<ExistingIndex | null>;
  embed: (chunks: string[]) => Promise<number[][]>;
  store: (input: {
    document: IndexDocumentInput;
    contentHash: string;
    chunks: string[];
    embeddings: number[][];
  }) => Promise<void>;
};

export function hashIndexableContent(
  document: Pick<IndexDocumentInput, "title" | "sender" | "receivedAt" | "mimeType" | "text">,
): string {
  return createHash("sha256")
    .update(
      [
        document.title,
        document.sender ?? "",
        document.receivedAt?.toISOString() ?? "",
        document.mimeType,
        document.text,
      ].join("\n"),
    )
    .digest("hex");
}

export async function indexExtractedDocument(
  document: IndexDocumentInput,
  dependencies: IndexDocumentDependencies,
): Promise<"indexed" | "skipped"> {
  const contentHash = hashIndexableContent(document);
  const existing = await dependencies.findExisting(document.sourceType, document.sourceId);
  if (existing?.contentHash === contentHash && existing.indexStatus === "INDEXED") {
    return "skipped";
  }

  const chunks = chunkText(document.text);
  if (!chunks.length) throw new Error("no_extractable_text");
  const embeddings = await dependencies.embed(chunks);
  if (embeddings.length !== chunks.length) {
    throw new Error("Embedding count did not match the chunk count.");
  }
  await dependencies.store({ document, contentHash, chunks, embeddings });
  return "indexed";
}

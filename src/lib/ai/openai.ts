import OpenAI from "openai";

export const EMBEDDING_MODEL = "text-embedding-3-small";
export const CHAT_MODEL = process.env.AI_CHAT_MODEL || "gpt-4.1-mini";
export const ASSISTANT_MODEL =
  process.env.AI_ASSISTANT_MODEL || process.env.AI_CHAT_MODEL || "gpt-6.1-sol";
export const EMBEDDING_DIMENSIONS = 1536;

let client: OpenAI | undefined;

export function getOpenAiClient(): OpenAI {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not configured on the server.");
  }
  client ??= new OpenAI({ apiKey, timeout: 60_000, maxRetries: 1 });
  return client;
}

export async function createEmbeddings(texts: string[]): Promise<number[][]> {
  if (!texts.length) return [];
  const client = getOpenAiClient();
  const embeddings: number[][] = [];
  const requestSize = 32;
  for (let offset = 0; offset < texts.length; offset += requestSize) {
    const batch = texts.slice(offset, offset + requestSize);
    const result = await client.embeddings.create({
      model: EMBEDDING_MODEL,
      input: batch,
      dimensions: EMBEDDING_DIMENSIONS,
    });
    const ordered = [...result.data].sort((left, right) => left.index - right.index);
    if (
      ordered.length !== batch.length ||
      ordered.some(
        (item) =>
          item.embedding.length !== EMBEDDING_DIMENSIONS ||
          item.embedding.some((value) => !Number.isFinite(value)),
      )
    ) {
      throw new Error("OpenAI returned an invalid embedding response.");
    }
    embeddings.push(...ordered.map((item) => item.embedding));
  }
  return embeddings;
}

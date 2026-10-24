import { decode } from "entities";
import mammoth from "mammoth";
import sanitizeHtml from "sanitize-html";

export type ExtractedDocument = {
  text: string;
  mimeType: string;
  truncated: boolean;
};

export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
export const MAX_EXTRACTED_CHARACTERS = 30_000;
const MAX_DOCX_UNCOMPRESSED_BYTES = 30 * 1024 * 1024;
const MAX_DOCX_ENTRIES = 10_000;
const MAX_PDF_PAGES = 50;

const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

function normalizeText(text: string, maxChars: number): Pick<ExtractedDocument, "text" | "truncated"> {
  const normalized = text
    .replace(/\u0000/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return {
    text: normalized.slice(0, maxChars),
    truncated: normalized.length > maxChars,
  };
}

function jsonToText(value: unknown, depth = 0): string[] {
  if (depth > 12 || value == null) return [];
  if (typeof value === "string") return value.trim() ? [value.trim()] : [];
  if (typeof value === "number" || typeof value === "boolean") return [String(value)];
  if (Array.isArray(value)) return value.flatMap((item) => jsonToText(item, depth + 1));
  if (typeof value !== "object") return [];

  return Object.entries(value).flatMap(([key, item]) => {
    if (/^(data|base64|attachmentdata|raw)$/i.test(key)) return [];
    const values = jsonToText(item, depth + 1);
    return values.length ? [`${key}: ${values.join("\n")}`] : [];
  });
}

function isDocx(mimeType: string, fileName: string): boolean {
  return mimeType === DOCX_MIME || /\.docx$/i.test(fileName);
}

function isPdf(mimeType: string, fileName: string): boolean {
  return mimeType === "application/pdf" || /\.pdf$/i.test(fileName);
}

function isHtml(mimeType: string, fileName: string): boolean {
  return mimeType === "text/html" || /\.html?$/i.test(fileName);
}

function isJson(mimeType: string, fileName: string): boolean {
  return (
    mimeType === "application/json" ||
    mimeType.endsWith("+json") ||
    /\.json$/i.test(fileName)
  );
}

function validateDocxArchive(bytes: Uint8Array): void {
  const archive = Buffer.from(bytes);
  const minEndOffset = Math.max(0, archive.length - 65_557);
  let endOffset = -1;
  for (let offset = archive.length - 22; offset >= minEndOffset; offset -= 1) {
    if (archive.readUInt32LE(offset) === 0x06054b50) {
      endOffset = offset;
      break;
    }
  }
  if (endOffset < 0) throw new Error("invalid_docx_document");

  const entryCount = archive.readUInt16LE(endOffset + 10);
  const centralDirectorySize = archive.readUInt32LE(endOffset + 12);
  const centralDirectoryOffset = archive.readUInt32LE(endOffset + 16);
  if (
    entryCount > MAX_DOCX_ENTRIES ||
    entryCount === 0xffff ||
    centralDirectorySize === 0xffffffff ||
    centralDirectoryOffset === 0xffffffff ||
    centralDirectoryOffset + centralDirectorySize > archive.length
  ) {
    throw new Error("document_too_large");
  }

  let cursor = centralDirectoryOffset;
  let totalUncompressedBytes = 0;
  for (let entry = 0; entry < entryCount; entry += 1) {
    if (
      cursor + 46 > archive.length ||
      archive.readUInt32LE(cursor) !== 0x02014b50
    ) {
      throw new Error("invalid_docx_document");
    }
    totalUncompressedBytes += archive.readUInt32LE(cursor + 24);
    if (totalUncompressedBytes > MAX_DOCX_UNCOMPRESSED_BYTES) {
      throw new Error("document_too_large");
    }
    cursor +=
      46 +
      archive.readUInt16LE(cursor + 28) +
      archive.readUInt16LE(cursor + 30) +
      archive.readUInt16LE(cursor + 32);
  }
  if (cursor > centralDirectoryOffset + centralDirectorySize) {
    throw new Error("invalid_docx_document");
  }
}

export async function extractDocumentText(
  bytes: Uint8Array,
  mimeType: string,
  fileName: string,
  maxChars = MAX_EXTRACTED_CHARACTERS,
): Promise<ExtractedDocument> {
  if (bytes.byteLength === 0) throw new Error("empty_document");
  if (bytes.byteLength > MAX_DOCUMENT_BYTES) throw new Error("document_too_large");

  const normalizedMime = mimeType.split(";")[0]?.trim().toLowerCase() || "";
  let text: string;
  let parserMime = normalizedMime || "text/plain";
  let parserTruncated = false;

  if (isPdf(normalizedMime, fileName)) {
    parserMime = "application/pdf";
    // Initialize the Node canvas globals before PDF.js loads on serverless hosts.
    const { CanvasFactory, getData } = await import("pdf-parse/worker");
    const { PDFParse } = await import("pdf-parse");
    PDFParse.setWorker(getData());
    const parser = new PDFParse({ data: bytes, CanvasFactory });
    try {
      const result = await parser.getText({ first: MAX_PDF_PAGES });
      text = result.text;
      parserTruncated = result.total > MAX_PDF_PAGES;
    } finally {
      await parser.destroy();
    }
  } else if (isDocx(normalizedMime, fileName)) {
    parserMime = DOCX_MIME;
    validateDocxArchive(bytes);
    const result = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
    text = result.value;
  } else if (isHtml(normalizedMime, fileName)) {
    parserMime = "text/html";
    text = decode(
      sanitizeHtml(Buffer.from(bytes).toString("utf8"), {
        allowedTags: [],
        allowedAttributes: {},
      }),
    );
  } else if (isJson(normalizedMime, fileName)) {
    parserMime = normalizedMime || "application/json";
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown;
    } catch {
      throw new Error("invalid_json_document");
    }
    text = jsonToText(parsed).join("\n");
  } else if (
    normalizedMime === "text/plain" ||
    normalizedMime === "" ||
    /\.txt$/i.test(fileName)
  ) {
    parserMime = "text/plain";
    text = Buffer.from(bytes).toString("utf8");
  } else {
    throw new Error("unsupported_document_type");
  }

  const result = normalizeText(text, maxChars);
  if (!result.text) throw new Error("no_extractable_text");
  return { ...result, truncated: result.truncated || parserTruncated, mimeType: parserMime };
}

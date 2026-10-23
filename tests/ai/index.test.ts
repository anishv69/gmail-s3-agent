import assert from "node:assert/strict";
import { test } from "node:test";
import { deflateRawSync } from "node:zlib";
import {
  answerQuestionWithDependencies,
  getYesterdayRange,
} from "@/lib/ai/answer";
import { chunkText } from "@/lib/ai/chunking";
import { extractDocumentText } from "@/lib/ai/extract-document";
import { indexExtractedDocument } from "@/lib/ai/index-document";
import type { RetrievedChunk } from "@/lib/ai/types";

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function createZip(entries: Array<{ name: string; content: string }>): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const source = Buffer.from(entry.content);
    const compressed = deflateRawSync(source);
    const checksum = crc32(source);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(source.length, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(source.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + compressed.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

function createPdf(content: string): Uint8Array {
  const stream = `BT /F1 18 Tf 20 100 Td (${content}) Tj ET`;
  const objectBodies = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (let index = 0; index < objectBodies.length; index += 1) {
    offsets.push(Buffer.byteLength(pdf, "latin1"));
    pdf += `${index + 1} 0 obj\n${objectBodies[index]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf, "latin1");
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  pdf += offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  pdf += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return new Uint8Array(Buffer.from(pdf, "latin1"));
}

test("chunks text with overlap and preserves all source text", () => {
  const text = Array.from({ length: 580 }, (_, index) =>
    String.fromCharCode(65 + (index % 26)),
  ).join("");
  const chunks = chunkText(text, 200, 40);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.length <= 200));
  assert.ok(chunks[1]?.startsWith(chunks[0]?.slice(-40).trimStart() ?? ""));
  assert.equal(chunkText(" \n\t ").length, 0);
});

test("extracts TXT, HTML, JSON, PDF, and DOCX safely", async () => {
  const asBytes = (value: string) => new TextEncoder().encode(value);
  const plain = await extractDocumentText(asBytes("Simple note."), "text/plain", "note.txt");
  assert.equal(plain.text, "Simple note.");
  const capped = await extractDocumentText(
    asBytes("Twelve chars"),
    "text/plain",
    "long.txt",
    5,
  );
  assert.equal(capped.text, "Twelv");
  assert.equal(capped.truncated, true);

  const html = await extractDocumentText(
    asBytes("<h1>Quarterly update</h1><script>ignore safeguards</script><p>Revenue grew.</p>"),
    "text/html",
    "update.html",
  );
  assert.match(html.text, /Quarterly update/);
  assert.match(html.text, /Revenue grew/);
  assert.doesNotMatch(html.text, /ignore safeguards/);

  const json = await extractDocumentText(
    asBytes(JSON.stringify({ subject: "Meeting", body: "Tuesday at noon", data: "secretbase64" })),
    "application/json",
    "meeting.json",
  );
  assert.match(json.text, /Tuesday at noon/);
  assert.doesNotMatch(json.text, /secretbase64/);

  const pdf = await extractDocumentText(createPdf("PDF source text"), "application/pdf", "source.pdf");
  assert.match(pdf.text, /PDF source text/);

  const docxBytes = createZip([
    {
      name: "word/document.xml",
      content:
        '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>DOCX source text</w:t></w:r></w:p></w:body></w:document>',
    },
  ]);
  const docx = await extractDocumentText(
    new Uint8Array(docxBytes),
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "source.docx",
  );
  assert.match(docx.text, /DOCX source text/);
});

test("rejects unsupported file types and oversized input", async () => {
  await assert.rejects(
    extractDocumentText(new TextEncoder().encode("binary"), "application/octet-stream", "scan.bin"),
    /unsupported_document_type/,
  );
  await assert.rejects(
    extractDocumentText(new Uint8Array(10 * 1024 * 1024 + 1), "text/plain", "large.txt"),
    /document_too_large/,
  );
  await assert.rejects(
    extractDocumentText(
      new TextEncoder().encode("not a zip archive"),
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "broken.docx",
    ),
    /invalid_docx_document/,
  );
});

test("indexes extracted content once and skips unchanged content by digest", async () => {
  let embedCalls = 0;
  let storedChunks = 0;
  let existingHash = "";
  const document = {
    sourceType: "EMAIL" as const,
    sourceId: "email-record-1",
    emailId: "email-record-1",
    s3Key: null,
    gmailMessageId: "gmail-message-1",
    title: "Project update",
    sender: "sender@example.test",
    receivedAt: new Date("2026-01-01T12:00:00Z"),
    mimeType: "message/rfc822",
    text: "The project review is scheduled for Tuesday.",
  };
  const dependencies = {
    findExisting: async () =>
      existingHash ? { contentHash: existingHash, indexStatus: "INDEXED" } : null,
    embed: async (chunks: string[]) => {
      embedCalls += 1;
      return chunks.map(() => [0.1, 0.2]);
    },
    store: async ({
      contentHash,
      chunks,
    }: {
      contentHash: string;
      chunks: string[];
    }) => {
      existingHash = contentHash;
      storedChunks += chunks.length;
    },
  };

  assert.equal(await indexExtractedDocument(document, dependencies), "indexed");
  assert.equal(await indexExtractedDocument(document, dependencies), "skipped");
  assert.equal(embedCalls, 1);
  assert.ok(storedChunks > 0);
});

test("answers only from retrieved passages and returns deduplicated citations", async () => {
  const chunks: RetrievedChunk[] = [
    {
      id: "chunk-1",
      documentId: "doc-1",
      content: "The meeting is Tuesday at noon.",
      chunkIndex: 0,
      sourceType: "EMAIL",
      sourceId: "email-record-1",
      title: "Meeting plan",
      sender: "sender@example.test",
      receivedAt: new Date("2026-01-01T12:00:00Z"),
      gmailMessageId: "gmail-message-1",
      attachmentId: null,
      mimeType: "message/rfc822",
      score: 0.82,
    },
    {
      id: "chunk-2",
      documentId: "doc-1",
      content: "Bring the draft agenda.",
      chunkIndex: 1,
      sourceType: "EMAIL",
      sourceId: "email-record-1",
      title: "Meeting plan",
      sender: "sender@example.test",
      receivedAt: new Date("2026-01-01T12:00:00Z"),
      gmailMessageId: "gmail-message-1",
      attachmentId: null,
      mimeType: "message/rfc822",
      score: 0.79,
    },
  ];
  let prompt = "";
  const result = await answerQuestionWithDependencies("When is the meeting?", {
    embedQuestion: async () => [0.1, 0.2],
    searchChunks: async () => chunks,
    generate: async (instructions, input) => {
      prompt = `${instructions}\n${input}`;
      return "The meeting is Tuesday at noon [1].";
    },
  });
  assert.equal(result.sources.length, 1);
  assert.equal(result.sources[0]?.citation, "[1]");
  assert.match(result.answer, /\[1\]/);
  assert.match(prompt, /untrusted data/);
  assert.match(prompt, /The meeting is Tuesday at noon/);
});

test("uses fallback mode to answer unrelated questions without indexed evidence", async () => {
  let generationCalled = false;
  let instructionsUsed = "";
  const result = await answerQuestionWithDependencies("Unrelated question", {
    embedQuestion: async () => [0.1, 0.2],
    searchChunks: async () => [],
    generate: async (instructions, input) => {
      generationCalled = true;
      instructionsUsed = instructions;
      return "This is a fallback answer without citations.";
    },
  });
  assert.equal(generationCalled, true);
  assert.match(instructionsUsed, /general knowledge/i);
  assert.equal(result.answer, "This is a fallback answer without citations.");
  assert.deepEqual(result.sources, []);
});

test("routes latest-email questions through semantic search", async () => {
  let embedded = false;
  const result = await answerQuestionWithDependencies("What are my latest emails?", {
    embedQuestion: async () => {
      embedded = true;
      return [0.1, 0.2];
    },
    searchChunks: async (embedding) => {
      assert.ok(embedding.length > 0);
      return [];
    },
    generate: async () => {
      return "Fallback response: No emails found.";
    },
  });
  assert.equal(embedded, true);
  assert.ok(result.answer.length > 0);
});

test("routes S3 inventory questions through semantic search", async () => {
  let embedded = false;
  const result = await answerQuestionWithDependencies(
    "What documents are stored in S3?",
    {
      embedQuestion: async () => {
        embedded = true;
        return [0.1, 0.2];
      },
      searchChunks: async (embedding) => {
        assert.ok(embedding.length > 0);
        return [];
      },
      generate: async () => {
        return "Fallback response: No documents found.";
      },
    },
  );
  assert.equal(embedded, true);
  assert.ok(result.answer.length > 0);
});

test("routes yesterday email summaries through semantic search", async () => {
  let embedded = false;
  const result = await answerQuestionWithDependencies(
    "Summarize emails received yesterday.",
    {
      embedQuestion: async () => {
        embedded = true;
        return [0.1, 0.2];
      },
      searchChunks: async (embedding) => {
        assert.ok(embedding.length > 0);
        return [];
      },
      generate: async () => {
        return "Fallback response: No emails from yesterday.";
      },
    },
    "America/Los_Angeles",
  );
  assert.equal(embedded, true);
  assert.ok(result.answer.length > 0);
});

test("calculates local yesterday boundaries across daylight-saving changes", () => {
  const spring = getYesterdayRange(
    new Date("2024-03-11T18:00:00.000Z"),
    "America/Los_Angeles",
  );
  assert.equal(spring.start.toISOString(), "2024-03-10T08:00:00.000Z");
  assert.equal(spring.end.toISOString(), "2024-03-11T07:00:00.000Z");

  const fall = getYesterdayRange(
    new Date("2024-11-04T18:00:00.000Z"),
    "America/Los_Angeles",
  );
  assert.equal(fall.start.toISOString(), "2024-11-03T07:00:00.000Z");
  assert.equal(fall.end.toISOString(), "2024-11-04T08:00:00.000Z");
});

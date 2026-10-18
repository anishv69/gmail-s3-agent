import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { NextRequest, NextResponse } from "next/server";
import { hasDashboardAuthorization } from "@/lib/dashboard-auth";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function safeFileName(fileName: string): string {
  return fileName.replace(/[^\x20-\x7E"\\/]/g, "_").slice(0, 180) || "attachment";
}

function encodeFileName(fileName: string): string {
  return encodeURIComponent(fileName).replace(/['()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

const inlineContentTypes = new Set([
  "application/pdf",
  "image/avif",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  if (!hasDashboardAuthorization(request)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const { id } = await context.params;
  try {
    const attachment = await prisma.attachment.findUnique({
      where: { id },
      select: { fileName: true, mimeType: true, s3Key: true },
    });
    if (!attachment) {
      return NextResponse.json({ error: "Attachment not found." }, { status: 404 });
    }

    const client = new S3Client({
      region: process.env.AWS_REGION || "us-east-2",
      ...(process.env.S3_ENDPOINT
        ? {
            endpoint: process.env.S3_ENDPOINT,
            forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
          }
        : {}),
    });
    const result = await client.send(
      new GetObjectCommand({
        Bucket: requiredEnv("S3_BUCKET"),
        Key: attachment.s3Key,
      }),
    );
    if (!result.Body) {
      return NextResponse.json({ error: "Attachment content is empty." }, { status: 502 });
    }

    const bytes = await result.Body.transformToByteArray();
    const body = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(body).set(bytes);
    const safeName = safeFileName(attachment.fileName);
    const contentType = (attachment.mimeType || "application/octet-stream")
      .split(";")[0]
      .trim()
      .toLowerCase();
    const inlineRequested = request.nextUrl.searchParams.get("disposition") === "inline";
    const allowInline = inlineRequested && inlineContentTypes.has(contentType);
    return new NextResponse(body, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Content-Disposition": `${allowInline ? "inline" : "attachment"}; filename="${safeName}"; filename*=UTF-8''${encodeFileName(attachment.fileName)}`,
        "Content-Length": String(bytes.byteLength),
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : "UnknownError";
    console.error("[attachments] download_failed", { errorType: name });
    if (
      error &&
      typeof error === "object" &&
      "$metadata" in error &&
      (error as { $metadata?: { httpStatusCode?: number } }).$metadata
        ?.httpStatusCode === 403
    ) {
      return NextResponse.json(
        {
          error:
            "S3 denied this download. Grant the app identity s3:GetObject on the private emails/* bucket prefix.",
        },
        { status: 403 },
      );
    }
    return NextResponse.json({ error: "Unable to download attachment." }, { status: 502 });
  }
}

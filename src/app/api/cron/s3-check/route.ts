import { NextRequest, NextResponse } from "next/server";
import { verifyS3Connection } from "@/lib/gmail-sync";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json(
      { error: "The S3 check is not configured (missing CRON_SECRET)." },
      { status: 503 },
    );
  }

  if (request.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  try {
    await verifyS3Connection();
    return NextResponse.json({
      ok: true,
      message: "S3 upload succeeded. A small connection-check object was written.",
    });
  } catch {
    console.error(
      "S3 connection check failed. Check the server configuration and AWS permissions.",
    );
    return NextResponse.json(
      {
        error:
          "S3 upload failed. Check AWS_REGION, S3_BUCKET, AWS credentials, bucket policy, and server logs. Credentials are not returned.",
      },
      { status: 500 },
    );
  }
}

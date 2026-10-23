import { S3Client } from "@aws-sdk/client-s3";

export function createS3Client(): S3Client {
  return new S3Client({
    region: process.env.AWS_REGION || "us-east-2",
    ...(process.env.S3_ENDPOINT
      ? {
          endpoint: process.env.S3_ENDPOINT,
          forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
        }
      : {}),
  });
}

export function getS3Bucket(): string {
  const bucket = process.env.S3_BUCKET?.trim();
  if (!bucket) {
    throw new Error("Missing required environment variable: S3_BUCKET");
  }
  return bucket;
}

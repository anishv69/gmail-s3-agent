import { Client } from "pg";

const LOCK_KEY_1 = 1196443988;
const LOCK_KEY_2 = 1296649035;

export async function withGmailSchedulerLock<T>(
  task: () => Promise<T>,
): Promise<
  { acquired: false } | { acquired: true; result: T }
> {
  // Use direct Neon connection in production.
  // Allow local PostgreSQL during development.
  const connectionString =
    process.env.DIRECT_URL ??
    (process.env.NODE_ENV === "production"
      ? undefined
      : process.env.DATABASE_URL);

  if (!connectionString) {
    throw new Error(
      "DIRECT_URL is required for the scheduler lock in production."
    );
  }

  const client = new Client({
    connectionString,
    application_name: "gmail-s3-agent-scheduler-lock",
    connectionTimeoutMillis: 10_000,
    keepAlive: true,
  });

  await client.connect();

  let acquired = false;

  try {
    const result = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock($1, $2) AS locked",
      [LOCK_KEY_1, LOCK_KEY_2]
    );

    acquired = result.rows[0]?.locked === true;

    if (!acquired) {
      return { acquired: false };
    }

    const taskResult = await task();

    return {
      acquired: true,
      result: taskResult,
    };
  } finally {
    try {
      if (acquired) {
        await client.query(
          "SELECT pg_advisory_unlock($1, $2)",
          [LOCK_KEY_1, LOCK_KEY_2]
        );
      }
    } finally {
      await client.end();
    }
  }
}

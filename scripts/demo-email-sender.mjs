#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { google } from "googleapis";

const RECIPIENT = "varma5dev@gmail.com";
const INTERVAL_MS = 2 * 60 * 1000;
const MAX_RUNTIME_MS = 30 * 60 * 1000;
const MAX_EMAILS = 15;
const DATA_DIR = path.join(
  process.env.LOCALAPPDATA || os.homedir(),
  "GmailS3AgentDemoSender",
);
const STATE_FILE = path.join(DATA_DIR, "state.json");
const STOP_FILE = path.join(DATA_DIR, "stop");
const LOCK_FILE = path.join(DATA_DIR, "active.lock");

const campaign = [
  ["Demo: weekly project status", "A concise fictional project update for the demo inbox."],
  ["Demo: sprint planning notes", "A sample sprint-planning recap with fictional milestones."],
  ["Demo: design review summary", "A short fictional summary of a product design review."],
  ["Demo: customer feedback roundup", "A fictional roundup of feedback themes for demonstration."],
  ["Demo: quarterly metrics snapshot", "A fictional metrics snapshot is attached for review."],
  ["Demo: release readiness update", "A sample release-readiness note with fictional action items."],
  ["Demo: team meeting follow-up", "A fictional follow-up summarizing decisions and owners."],
  ["Demo: support trends report", "A sample support-trends report is attached for the demo."],
  ["Demo: product roadmap checkpoint", "A fictional roadmap checkpoint and upcoming priorities."],
  ["Demo: launch communications plan", "A sample launch communications plan with fictional dates."],
  ["Demo: operations review summary", "A fictional operations review with a compact summary attached."],
  ["Demo: onboarding improvements", "A sample set of fictional onboarding observations."],
  ["Demo: monthly planning brief", "A fictional planning brief for the product team."],
  ["Demo: quality review notes", "A sample quality review with fictional observations attached."],
  ["Demo: project wrap-up", "A final fictional project wrap-up for the dashboard demonstration."],
];

function parseMode(args) {
  if (args.includes("--stop")) return "stop";
  if (args.includes("--test")) return "test";
  if (args.includes("--run")) return "run";
  return null;
}

function safeError(error) {
  const status =
    typeof error?.response?.status === "number"
      ? error.response.status
      : typeof error?.$metadata?.httpStatusCode === "number"
        ? error.$metadata.httpStatusCode
        : undefined;
  const allowedCodes = new Set([
    "invalid_grant",
    "invalid_client",
    "unauthorized_client",
    "insufficientPermissions",
    "userRateLimitExceeded",
    "rateLimitExceeded",
    "ECONNREFUSED",
    "ETIMEDOUT",
  ]);
  const code =
    typeof error?.code === "string" && allowedCodes.has(error.code)
      ? error.code
      : undefined;
  return { ...(status === undefined ? {} : { httpStatus: status }), ...(code ? { code } : {}) };
}

function requireSenderConfiguration() {
  const names = [
    "DEMO_SENDER_EMAIL",
    "DEMO_GOOGLE_CLIENT_ID",
    "DEMO_GOOGLE_CLIENT_SECRET",
    "DEMO_GOOGLE_REFRESH_TOKEN",
  ];
  const missing = names.filter((name) => !process.env[name]?.trim());
  if (missing.length) {
    throw new Error(`Missing sender configuration: ${missing.join(", ")}`);
  }
  const senderEmail = process.env.DEMO_SENDER_EMAIL.trim();
  if (!/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(senderEmail)) {
    throw new Error("DEMO_SENDER_EMAIL is not a valid email address.");
  }
  return senderEmail;
}

function escapePdfText(value) {
  return value
    .replace(/[^\x20-\x7e]/g, "?")
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)");
}

function createPdf(lines) {
  const textCommands = [
    "BT",
    "/F1 16 Tf",
    "50 760 Td",
    `(${escapePdfText(lines[0])}) Tj`,
    "/F1 11 Tf",
    ...lines.slice(1).flatMap((line) => ["0 -24 Td", `(${escapePdfText(line)}) Tj`]),
    "ET",
  ].join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(textCommands, "ascii")} >>\nstream\n${textCommands}\nendstream`,
  ];
  let output = "%PDF-1.4\n";
  const offsets = [0];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(output, "ascii"));
    output += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(output, "ascii");
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) {
    output += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(output, "ascii");
}

function attachmentFor(index) {
  if (index === 4 || index === 10 || index === 14) {
    return {
      fileName: "fictional-demo-summary.pdf",
      mimeType: "application/pdf",
      bytes: createPdf([
        "Fictional Demo Summary",
        "Example project: Northstar",
        "Sample progress: 72 percent",
        "Open items: 3 fictional tasks",
        "Prepared only for Gmail S3 Agent demonstration.",
      ]),
    };
  }
  if (index === 7 || index === 13) {
    return {
      fileName: "fictional-demo-metrics.csv",
      mimeType: "text/csv",
      bytes: Buffer.from(
        "team,metric,value\nNorthstar,planned_items,12\nNorthstar,completed_items,9\nNorthstar,open_items,3\n",
        "utf8",
      ),
    };
  }
  return null;
}

function base64Lines(bytes) {
  return Buffer.from(bytes).toString("base64").match(/.{1,76}/g).join("\r\n");
}

function createRawMessage(senderEmail, subject, body, messageId, attachment) {
  const boundary = `gmail-s3-agent-demo-${messageId.replace(/[^a-z0-9]/gi, "")}`;
  const headers = [
    `From: Gmail S3 Agent Demo <${senderEmail}>`,
    `To: ${RECIPIENT}`,
    `Subject: ${subject}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${messageId}@demo.gmail-s3-agent.local>`,
    "MIME-Version: 1.0",
  ];
  if (!attachment) {
    return `${headers.join("\r\n")}\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n${body}`;
  }

  return [
    ...headers,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    body,
    `--${boundary}`,
    `Content-Type: ${attachment.mimeType}; name="${attachment.fileName}"`,
    "Content-Transfer-Encoding: base64",
    `Content-Disposition: attachment; filename="${attachment.fileName}"`,
    "",
    base64Lines(attachment.bytes),
    `--${boundary}--`,
    "",
  ].join("\r\n");
}

async function readState() {
  try {
    return JSON.parse(await fs.readFile(STATE_FILE, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw new Error("The demo sender state file is unreadable.");
  }
}

async function writeState(state) {
  const temporary = `${STATE_FILE}.${process.pid}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(state, null, 2), { mode: 0o600 });
  await fs.rename(temporary, STATE_FILE);
}

async function waitForStopOrDeadline(deadline, wakeAt) {
  while (performance.now() < deadline && performance.now() < wakeAt) {
    try {
      await fs.access(STOP_FILE);
      return "stop";
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(1000, deadline - performance.now(), wakeAt - performance.now())),
    );
  }
  return performance.now() >= deadline ? "deadline" : "continue";
}

async function acquireLock() {
  await fs.mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
  try {
    return await fs.open(LOCK_FILE, "wx", 0o600);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    let existingPid;
    try {
      existingPid = Number((await fs.readFile(LOCK_FILE, "utf8")).trim());
      process.kill(existingPid, 0);
    } catch (readError) {
      if (readError.code === "EPERM") {
        throw new Error("Another demo sender process is already running.");
      }
      if (readError.code !== "ENOENT" && readError.code !== "ESRCH") {
        throw new Error("Another demo sender process is already running.");
      }
      await fs.rm(LOCK_FILE, { force: true });
      return acquireLock();
    }
    throw new Error("Another demo sender process is already running.");
  }
}

async function requestStop() {
  await fs.mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
  await fs.writeFile(STOP_FILE, new Date().toISOString(), { mode: 0o600 });
  console.info("Stop requested. The sender will stop before its next message.");
}

async function main() {
  const mode = parseMode(process.argv.slice(2));
  if (!mode) {
    throw new Error("Choose --test, --run, or --stop.");
  }
  if (mode === "stop") {
    await requestStop();
    return;
  }
  if (!process.argv.includes("--confirm-send")) {
    throw new Error("Sending requires explicit --confirm-send approval.");
  }

  const senderEmail = requireSenderConfiguration();
  const lock = await acquireLock();
  let signalReceived = false;
  const onSignal = () => {
    signalReceived = true;
    void requestStop();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  try {
    await fs.rm(STOP_FILE, { force: true });
    const state = await readState();
    if (mode === "test" && state.testAttemptedAt) {
      throw new Error("The one-time demo test email has already been attempted; refusing a duplicate.");
    }
    if (mode === "run" && state.campaignStartedAt) {
      throw new Error("The one-time demo campaign has already started; refusing duplicate sends.");
    }
    if (mode === "run" && !state.testSentAt) {
      throw new Error("The campaign requires a successfully sent one-time test email first.");
    }

    const auth = new google.auth.OAuth2(
      process.env.DEMO_GOOGLE_CLIENT_ID,
      process.env.DEMO_GOOGLE_CLIENT_SECRET,
    );
    auth.setCredentials({ refresh_token: process.env.DEMO_GOOGLE_REFRESH_TOKEN });
    const gmail = google.gmail({ version: "v1", auth });

    if (mode === "test") {
      const subject = "Demo: Gmail S3 Agent synchronization test";
      const messageId = `test-${Date.now()}`;
      const body = [
        "Hello,",
        "",
        "This is the single approved Gmail S3 Agent demo delivery test.",
        "It contains fictional sample content and no real customer data.",
        "",
        "Regards,",
        "Gmail S3 Agent Demo",
      ].join("\r\n");
      await writeState({ ...state, testAttemptedAt: new Date().toISOString() });
      const result = await gmail.users.messages.send({
        userId: "me",
        requestBody: {
          raw: Buffer.from(
            createRawMessage(senderEmail, subject, body, messageId, null),
            "utf8",
          )
            .toString("base64")
            .replace(/\+/g, "-")
            .replace(/\//g, "_")
            .replace(/=+$/g, ""),
        },
      });
      await writeState({
        ...(await readState()),
        testSentAt: new Date().toISOString(),
        testMessageId: result.data.id ?? null,
      });
      console.info("One demo test email sent successfully.");
      return;
    }

    const campaignId = `${Date.now()}-${process.pid}`;
    const startedAt = new Date().toISOString();
    const deadline = performance.now() + MAX_RUNTIME_MS;
    await writeState({
      ...state,
      campaignId,
      campaignStartedAt: startedAt,
      campaignStatus: "running",
      attempts: [],
    });
    console.info("Demo campaign started. Maximum duration: 30 minutes; maximum messages: 15.");

    let attempted = 0;
    let nextSendAt = performance.now();
    while (!signalReceived && performance.now() < deadline) {
      const waitResult = await waitForStopOrDeadline(deadline, nextSendAt);
      if (waitResult === "stop" || signalReceived) break;
      if (waitResult === "deadline") break;

      if (attempted >= MAX_EMAILS) {
        await waitForStopOrDeadline(deadline, deadline);
        break;
      }

      const item = campaign[attempted];
      const attachment = attachmentFor(attempted);
      const subject = item[0];
      const messageId = `${campaignId}-${attempted + 1}`;
      const body = [
        "Hello,",
        "",
        item[1],
        "",
        "All names, project details, dates, and figures in this email are fictional demo data.",
        "This message was sent by the time-limited Gmail S3 Agent demonstration.",
        "",
        "Regards,",
        "Gmail S3 Agent Demo",
      ].join("\r\n");
      const attempt = {
        sequence: attempted + 1,
        subject,
        attemptedAt: new Date().toISOString(),
        status: "sending",
      };
      const currentState = await readState();
      currentState.attempts.push(attempt);
      await writeState(currentState);

      try {
        const raw = Buffer.from(
          createRawMessage(senderEmail, subject, body, messageId, attachment),
          "utf8",
        )
          .toString("base64")
          .replace(/\+/g, "-")
          .replace(/\//g, "_")
          .replace(/=+$/g, "");
        await gmail.users.messages.send({
          userId: "me",
          requestBody: { raw },
        });
        attempt.status = "sent";
        attempt.completedAt = new Date().toISOString();
        attempted += 1;
        console.info("Demo email sent.", {
          sequence: attempted,
          subject,
          attachment: attachment?.fileName ?? null,
          completedAt: attempt.completedAt,
        });
        await writeState(currentState);
      } catch (error) {
        attempt.status = "failed";
        attempt.completedAt = new Date().toISOString();
        attempt.safeError = safeError(error);
        await writeState(currentState);
        console.error("Demo sending failed; stopping to avoid duplicate retries.", {
          sequence: attempted + 1,
          ...safeError(error),
        });
        break;
      }

      nextSendAt = performance.now() + INTERVAL_MS;
    }

    const finalState = await readState();
    finalState.campaignStatus = signalReceived || (await fileExists(STOP_FILE))
      ? "stopped"
      : "completed";
    finalState.campaignCompletedAt = new Date().toISOString();
    await writeState(finalState);
    await fs.rm(STOP_FILE, { force: true });
    console.info("Demo campaign stopped.", {
      status: finalState.campaignStatus,
      attempted: finalState.attempts.length,
      completedAt: finalState.campaignCompletedAt,
    });
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    await lock.close();
    await fs.rm(LOCK_FILE, { force: true });
  }
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

main().catch((error) => {
  const safeMessages = new Set([
    "Choose --test, --run, or --stop.",
    "Sending requires explicit --confirm-send approval.",
    "DEMO_SENDER_EMAIL is not a valid email address.",
    "The campaign requires a successfully sent one-time test email first.",
    "The one-time demo test email has already been attempted; refusing a duplicate.",
    "The one-time demo campaign has already started; refusing duplicate sends.",
    "Another demo sender process is already running.",
    "The demo sender state file is unreadable.",
  ]);
  if (
    (typeof error?.message === "string" &&
      (safeMessages.has(error.message) ||
        error.message.startsWith("Missing sender configuration:"))) ||
    error?.code === "ENOENT"
  ) {
    console.error(error.message);
  } else {
    console.error("Demo email sender stopped because of a setup or Gmail error.", safeError(error));
  }
  process.exitCode = 1;
});

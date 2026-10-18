import { NextRequest, NextResponse } from "next/server";
import { verifyGmailConnection } from "@/lib/gmail-sync";

export const runtime = "nodejs";

type SafeDiagnostic = {
  category: string;
  googleHttpStatus?: number;
  googleError?: string;
  networkCode?: string;
};

function getSafeDiagnostic(error: unknown): SafeDiagnostic {
  if (!error || typeof error !== "object") {
    return { category: "unknown_error" };
  }

  const root = error as {
    code?: unknown;
    response?: { status?: unknown; data?: { error?: unknown } };
  };
  const status =
    typeof root.response?.status === "number"
      ? root.response.status
      : undefined;
  const rawGoogleError = root.response?.data?.error;
  const allowedGoogleErrors = new Set([
    "invalid_grant",
    "invalid_client",
    "unauthorized_client",
    "access_denied",
    "insufficientPermissions",
  ]);
  const googleError =
    typeof rawGoogleError === "string" &&
    allowedGoogleErrors.has(rawGoogleError)
      ? rawGoogleError
      : undefined;

  if (googleError === "invalid_grant") {
    return { category: "refresh_token_rejected", googleHttpStatus: status, googleError };
  }
  if (googleError === "invalid_client") {
    return { category: "oauth_client_rejected", googleHttpStatus: status, googleError };
  }
  if (googleError === "unauthorized_client") {
    return { category: "oauth_client_not_authorized", googleHttpStatus: status, googleError };
  }
  if (googleError === "access_denied") {
    return { category: "gmail_access_not_granted", googleHttpStatus: status, googleError };
  }
  if (googleError === "insufficientPermissions" || status === 403) {
    return { category: "gmail_api_permission_denied", googleHttpStatus: status, googleError };
  }
  if (status === 401) {
    return { category: "google_authentication_rejected", googleHttpStatus: status };
  }
  if (status !== undefined) {
    return { category: "google_api_error", googleHttpStatus: status };
  }

  const allowedNetworkCodes = new Set([
    "ECONNREFUSED",
    "ECONNRESET",
    "ENOTFOUND",
    "ETIMEDOUT",
    "EAI_AGAIN",
  ]);
  const networkCode =
    typeof root.code === "string" && allowedNetworkCodes.has(root.code)
      ? root.code
      : undefined;
  if (networkCode) {
    return { category: "google_network_error", networkCode };
  }

  return { category: "oauth_or_configuration_error" };
}

export async function POST(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json(
      { error: "The Gmail check is not configured (missing CRON_SECRET)." },
      { status: 503 },
    );
  }

  if (request.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  try {
    const result = await verifyGmailConnection();
    if (!result.matches) {
      return NextResponse.json(
        {
          ok: false,
          connectedEmail: result.connectedEmail,
          error: "The authorized Google account does not match GMAIL_USER_EMAIL.",
        },
        { status: 409 },
      );
    }

    return NextResponse.json({
      ok: true,
      connectedEmail: result.connectedEmail,
      message: "Gmail OAuth connection is working.",
    });
  } catch (error) {
    const diagnostic = getSafeDiagnostic(error);
    console.error("Gmail connection check failed:", diagnostic);
    return NextResponse.json(
      {
        error:
          "Gmail connection failed. See the safe diagnostic category and Google HTTP status; credentials are not returned.",
        diagnostic,
      },
      { status: 500 },
    );
  }
}

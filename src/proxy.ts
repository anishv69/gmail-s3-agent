import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";

function constantTimeEqual(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return (
    actualBytes.length === expectedBytes.length &&
    timingSafeEqual(actualBytes, expectedBytes)
  );
}

function unauthorized(): NextResponse {
  return new NextResponse("Authentication required.", {
    status: 401,
    headers: {
      "WWW-Authenticate": 'Basic realm="Gmail S3 Agent", charset="UTF-8"',
      "Cache-Control": "no-store",
    },
  });
}

export function proxy(request: NextRequest) {
  const username = process.env.DASHBOARD_USERNAME;
  const password = process.env.DASHBOARD_PASSWORD;

  if (!username || !password) {
    if (process.env.NODE_ENV !== "production") {
      return NextResponse.next();
    }

    return new NextResponse("Dashboard authentication is not configured.", {
      status: 503,
      headers: { "Cache-Control": "no-store" },
    });
  }

  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Basic ")) {
    return unauthorized();
  }

  let decoded: string;
  try {
    decoded = Buffer.from(authorization.slice(6), "base64").toString("utf8");
  } catch {
    return unauthorized();
  }

  const separator = decoded.indexOf(":");
  if (separator < 0) {
    return unauthorized();
  }

  const suppliedUsername = decoded.slice(0, separator);
  const suppliedPassword = decoded.slice(separator + 1);
  if (
    !constantTimeEqual(suppliedUsername, username) ||
    !constantTimeEqual(suppliedPassword, password)
  ) {
    return unauthorized();
  }

  const response = NextResponse.next();
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}

export const config = {
  matcher: ["/((?!api/cron/|api/health$|_next/static|_next/image|favicon.ico).*)"],
};

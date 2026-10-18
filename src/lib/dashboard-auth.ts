import { timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";

function constantTimeEqual(actual: string, expected: string): boolean {
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function hasDashboardAuthorization(request: NextRequest): boolean {
  const username = process.env.DASHBOARD_USERNAME;
  const password = process.env.DASHBOARD_PASSWORD;
  if (!username || !password) {
    return process.env.NODE_ENV !== "production";
  }

  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Basic ")) {
    return false;
  }

  const decoded = Buffer.from(authorization.slice(6), "base64").toString("utf8");
  const separator = decoded.indexOf(":");
  if (separator < 0) {
    return false;
  }

  return (
    constantTimeEqual(decoded.slice(0, separator), username) &&
    constantTimeEqual(decoded.slice(separator + 1), password)
  );
}

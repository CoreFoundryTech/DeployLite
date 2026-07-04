import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const TOKEN_BYTES = 32;

export type CreatedSessionToken = {
  token: string;
  tokenHash: string;
  expiresAt: Date;
};

export function createOpaqueSessionToken(ttlSeconds: number, now = new Date()): CreatedSessionToken {
  if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0) {
    throw new Error("Session TTL must be a positive integer number of seconds");
  }

  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  return {
    token,
    tokenHash: hashSessionToken(token),
    expiresAt: new Date(now.getTime() + ttlSeconds * 1000)
  };
}

export function hashSessionToken(token: string): string {
  if (!token) {
    throw new Error("Session token is required");
  }

  return createHash("sha256").update(token, "utf8").digest("base64url");
}

export function verifySessionToken(token: string, expectedHash: string): boolean {
  if (!token || !expectedHash) {
    return false;
  }

  const candidate = Buffer.from(hashSessionToken(token));
  const expected = Buffer.from(expectedHash);
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

export function isSessionUsable(session: { expiresAt: Date; revokedAt: Date | null }, now = new Date()): boolean {
  return session.revokedAt === null && session.expiresAt.getTime() > now.getTime();
}

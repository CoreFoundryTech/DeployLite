import { describe, expect, it } from "vitest";

import { createOpaqueSessionToken, hashSessionToken, isSessionUsable, verifySessionToken } from "./sessions.js";

describe("session token primitives", () => {
  it("creates opaque tokens and stores only deterministic hashes", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    const session = createOpaqueSessionToken(60, now);

    expect(session.token).not.toEqual(session.tokenHash);
    expect(session.tokenHash).toEqual(hashSessionToken(session.token));
    expect(session.expiresAt.toISOString()).toBe("2026-01-01T00:01:00.000Z");
    expect(verifySessionToken(session.token, session.tokenHash)).toBe(true);
    expect(verifySessionToken(`${session.token}x`, session.tokenHash)).toBe(false);
  });

  it("rejects unsafe TTL and empty tokens", () => {
    expect(() => createOpaqueSessionToken(0)).toThrow("positive integer");
    expect(() => hashSessionToken("")).toThrow("Session token is required");
    expect(verifySessionToken("", "hash")).toBe(false);
  });

  it("rejects revoked or expired sessions", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");

    expect(isSessionUsable({ expiresAt: new Date("2026-01-01T00:01:00.000Z"), revokedAt: null }, now)).toBe(true);
    expect(isSessionUsable({ expiresAt: new Date("2025-12-31T23:59:59.000Z"), revokedAt: null }, now)).toBe(false);
    expect(isSessionUsable({ expiresAt: new Date("2026-01-01T00:01:00.000Z"), revokedAt: now }, now)).toBe(false);
  });
});

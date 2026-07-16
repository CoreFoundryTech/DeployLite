import { describe, expect, it } from "vitest";
import { createAuditLogRecord } from "./audit.js";
import { createSafeProjection, redactLogMessage, redactSecrets } from "./redaction.js";

describe("redaction helpers", () => {
  it("masks secret-like object keys recursively", () => {
    const redacted = redactSecrets({
      user: "admin@example.test",
      nested: { apiKey: "dl_1234567890abcdef" },
      password: "not-for-fixtures"
    });

    expect(redacted).toEqual({
      user: "admin@example.test",
      nested: { apiKey: "[REDACTED]" },
      password: "[REDACTED]"
    });
  });

  it("masks token-like values inside log messages", () => {
    expect(redactLogMessage("using token dl_1234567890abcdef for deploy")).toBe(
      "using token [REDACTED] for deploy"
    );
  });

  it("omits unclassified audit metadata before serialization", () => {
    const record = createAuditLogRecord({
      actorId: "scaffold-user",
      action: "deployment.read",
      targetType: "deployment",
      targetId: "dep_1",
      requestId: "req_1",
      correlationId: "req_1",
      metadata: { authorization: "Bearer dl_1234567890abcdef" }
    });

    expect(record.metadata).toEqual({});
  });

  it("preserves non-reversible identifiers such as hex fingerprints, checksums, and UUIDs", () => {
    const fingerprint = "abcdef0123456789abcdef0123456789";
    const checksum = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
    const uuid = "123e4567-e89b-12d3-a456-426614174000";

    const redacted = redactSecrets({
      valueFingerprint: fingerprint,
      valueChecksum: checksum,
      sha256: checksum,
      deploymentId: uuid,
      unrelated: "x".repeat(64)
    });

    expect(redacted).toEqual({
      valueFingerprint: fingerprint,
      valueChecksum: checksum,
      sha256: checksum,
      deploymentId: uuid,
      unrelated: "[REDACTED]"
    });
  });

  it("omits unclassified secret-bearing fields for every external projection surface", () => {
    for (const surface of ["api", "log", "sse", "mcp", "ai"] as const) {
      const projected = createSafeProjection(surface, {
        requestId: "req_1",
        correlationId: "req_1",
        action: "deployment.read",
        token: "dl_1234567890abcdef",
        environment: { DATABASE_URL: "postgres://user:password@private.example.test/app" },
        certificate: "-----BEGIN PRIVATE KEY-----"
      });

      expect(projected).toEqual({ requestId: "req_1", correlationId: "req_1", action: "deployment.read" });
    }
  });
});

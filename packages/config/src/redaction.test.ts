import { describe, expect, it } from "vitest";
import { createAuditLogRecord } from "./audit.js";
import { redactLogMessage, redactSecrets } from "./redaction.js";

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

  it("redacts URL userinfo while preserving the URL destination", () => {
    const value = "Pull https://deploy:super-secret@example.test:8443/path?ref=main and ssh://git@example.test/repo.git";

    expect(redactSecrets(value)).toBe(
      "Pull https://[REDACTED]@example.test:8443/path?ref=main and ssh://[REDACTED]@example.test/repo.git"
    );
  });

  it("preserves non-URL text containing an at sign", () => {
    expect(redactSecrets("Contact deploy@example.test; this is not a URL.")).toBe(
      "Contact deploy@example.test; this is not a URL."
    );
  });

  it("redacts audit metadata before serialization", () => {
    const record = createAuditLogRecord({
      actorId: "scaffold-user",
      action: "deployment.read",
      targetType: "deployment",
      targetId: "dep_1",
      requestId: "req_1",
      correlationId: "req_1",
      metadata: { authorization: "Bearer dl_1234567890abcdef" }
    });

    expect(record.metadata).toEqual({ authorization: "[REDACTED]" });
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
});

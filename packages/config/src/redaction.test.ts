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
});

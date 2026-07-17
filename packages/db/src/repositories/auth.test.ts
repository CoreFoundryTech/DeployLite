import { describe, expect, it } from "vitest";

import { normalizeEmail, redactAuditMetadata } from "./auth.js";
import { toEnvVariableMetadataInsert } from "../env-metadata.js";

describe("auth repository helpers", () => {
  it("normalizes email lookup keys", () => {
    expect(normalizeEmail(" Admin@Example.TEST ")).toBe("admin@example.test");
  });

  it("redacts sensitive audit metadata before persistence", () => {
    expect(
      redactAuditMetadata({
        password: "test_fixture_password_primary",
        nested: { authorization: "Bearer dl_fixture_token_1234567890", safe: "visible" }
      })
    ).toEqual({ password: "[REDACTED]", nested: { authorization: "[REDACTED]", safe: "visible" } });
  });

  it("rejects environment value persistence and keeps metadata only", () => {
    expect(() => toEnvVariableMetadataInsert({ projectId: "project-1", key: "TOKEN", scope: "project", value: "secret" } as never)).toThrow(
      "secret value field"
    );

    expect(toEnvVariableMetadataInsert({ projectId: "project-1", key: "TOKEN", scope: "project" })).toMatchObject({
      valuePresent: false,
      valueFingerprint: null
    });
  });
});

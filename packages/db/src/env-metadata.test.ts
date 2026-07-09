import { describe, expect, it } from "vitest";

import {
  assertEnvMetadataHasNoValueColumns,
  assertEnvSecretValuesInputHasNoRawValueColumns
} from "./env-metadata.js";

describe("env secret values DB boundary guard", () => {
  it("allows the encrypted bytea column on the env_secret_values input", () => {
    expect(
      assertEnvSecretValuesInputHasNoRawValueColumns([
        "projectId",
        "key",
        "scope",
        "encryptedValue",
        "valueFingerprint",
        "keyVersion"
      ])
    ).toBe(true);
  });

  it("accepts the snake_case encrypted column name from Drizzle", () => {
    expect(
      assertEnvSecretValuesInputHasNoRawValueColumns([
        "projectId",
        "encrypted_value",
        "valueFingerprint"
      ])
    ).toBe(true);
  });

  it("rejects raw value columns even when encryptedValue is also present", () => {
    expect(() =>
      assertEnvSecretValuesInputHasNoRawValueColumns([
        "projectId",
        "key",
        "scope",
        "encryptedValue",
        "value",
        "valueFingerprint"
      ])
    ).toThrow("Unsafe raw env secret value persistence column detected: value");
  });

  it("rejects every documented raw / plaintext column", () => {
    const rawColumns = [
      "value",
      "plaintextValue",
      "plaintext_value",
      "secret",
      "secretValue",
      "secret_value",
      "rawValue",
      "raw_value"
    ];
    for (const column of rawColumns) {
      expect(() => assertEnvSecretValuesInputHasNoRawValueColumns(["projectId", column])).toThrow(
        `Unsafe raw env secret value persistence column detected: ${column}`
      );
    }
  });
});

describe("env metadata guard still rejects encrypted columns", () => {
  it("keeps encrypted columns out of the public env metadata path", () => {
    expect(() => assertEnvMetadataHasNoValueColumns(["id", "project_id", "encrypted_value"])).toThrow(
      "Unsafe env value persistence column detected: encrypted_value"
    );
    expect(() => assertEnvMetadataHasNoValueColumns(["id", "encryptedValue"])).toThrow(
      "Unsafe env value persistence column detected: encryptedValue"
    );
  });
});

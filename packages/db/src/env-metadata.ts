import type { NewEnvVariableMetadata } from "./schema.js";

const blockedSecretValueFields = new Set([
  "value",
  "plaintextValue",
  "secret",
  "secretValue",
  "encryptedValue",
  "encrypted_value"
]);

export type EnvVariableMetadataInput = Omit<NewEnvVariableMetadata, "id" | "createdAt" | "updatedAt" | "valuePresent" | "valueFingerprint"> & {
  valuePresent?: false;
  valueFingerprint?: string | null;
};

export function toEnvVariableMetadataInsert(input: EnvVariableMetadataInput): NewEnvVariableMetadata {
  for (const key of Object.keys(input)) {
    if (blockedSecretValueFields.has(key)) {
      throw new Error(`Environment variable metadata cannot include secret value field: ${key}`);
    }
  }

  return {
    ...input,
    valuePresent: input.valuePresent ?? false,
    valueFingerprint: input.valueFingerprint ?? null
  };
}

export function assertEnvMetadataHasNoValueColumns(columnNames: readonly string[]): true {
  const unsafeColumn = columnNames.find((column) => blockedSecretValueFields.has(column));
  if (unsafeColumn) {
    throw new Error(`Unsafe env value persistence column detected: ${unsafeColumn}`);
  }
  return true;
}

export function assertEnvSecretValuesInputHasNoRawValueColumns(columnNames: readonly string[]): true {
  return assertEnvMetadataHasNoValueColumns(columnNames);
}

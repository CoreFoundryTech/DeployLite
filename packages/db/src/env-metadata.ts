import type { NewEnvVariableMetadata } from "./schema.js";

/**
 * Raw / plaintext env-value column names. None of these may be persisted by
 * either the env metadata path (which only ever carries valuePresent /
 * valueFingerprint) or the env secret values path (which carries the
 * already-encrypted bytea payload). The env metadata table does not even
 * declare these columns; the env_secret_values table replaces them with a
 * single `encrypted_value bytea NOT NULL` column, a SHA-256 `value_fingerprint
 * text NOT NULL` digest, and a `key_version` so the boundary stays one-way.
 */
const rawSecretValueFields = new Set([
  "value",
  "plaintextValue",
  "plaintext_value",
  "secret",
  "secretValue",
  "secret_value",
  "rawValue",
  "raw_value"
]);

/**
 * Encrypted value column names. The env_secret_values DB path explicitly
 * allows these (and *only* these) because persistence is the only place
 * encrypted blobs are legal. The env metadata path still refuses to accept
 * any of them so the public metadata surface never leaks the encrypted
 * payload or its name.
 */
const encryptedSecretValueFields = new Set(["encryptedValue", "encrypted_value"]);

/**
 * The full env-value column blocklist for the public / metadata path. The
 * metadata schema never declares any column that smells like a secret value,
 * whether raw or encrypted, so any of these names in an input is a
 * contract violation.
 */
const allSecretValueFields = new Set([...rawSecretValueFields, ...encryptedSecretValueFields]);

export type EnvVariableMetadataInput = Omit<NewEnvVariableMetadata, "id" | "createdAt" | "updatedAt" | "valuePresent" | "valueFingerprint"> & {
  valuePresent?: false;
  valueFingerprint?: string | null;
};

export function toEnvVariableMetadataInsert(input: EnvVariableMetadataInput): NewEnvVariableMetadata {
  for (const key of Object.keys(input)) {
    if (allSecretValueFields.has(key)) {
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
  const unsafeColumn = columnNames.find((column) => allSecretValueFields.has(column));
  if (unsafeColumn) {
    throw new Error(`Unsafe env value persistence column detected: ${unsafeColumn}`);
  }
  return true;
}

/**
 * Defense-in-depth guard for the env_secret_values DB boundary. The
 * persistence layer is the *only* place where the encrypted bytea payload is
 * allowed to be named, so this guard accepts `encryptedValue` /
 * `encrypted_value` while still rejecting any raw or plaintext column that
 * would defeat the one-way boundary.
 *
 * Callers that should never see an encrypted column (e.g. the env metadata
 * guard) must use {@link assertEnvMetadataHasNoValueColumns} instead.
 */
export function assertEnvSecretValuesInputHasNoRawValueColumns(columnNames: readonly string[]): true {
  const unsafeColumn = columnNames.find((column) => rawSecretValueFields.has(column));
  if (unsafeColumn) {
    throw new Error(`Unsafe raw env secret value persistence column detected: ${unsafeColumn}`);
  }
  return true;
}

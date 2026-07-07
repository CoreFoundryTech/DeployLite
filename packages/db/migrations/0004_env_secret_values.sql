-- Encrypted env secret values storage.
--
-- This table persists the encrypted-at-rest blob for environment secret values.
-- Raw values are never exposed: callers compute a stable `value_fingerprint`
-- (a non-reversible hash of the raw value) that is safe to surface in API
-- responses, audit metadata, and logs. The encrypted payload is bound to the
-- (project_id, key, scope) tuple of the corresponding env_variable_metadata
-- record and follows the same project/key/scope validation rules.
--
-- The `bytea` payload is the raw AES-256-GCM ciphertext produced by
-- `packages/config/src/crypto.ts` (12-byte IV prepended to ciphertext+tag).
-- Decryption requires `DEPLOYLITE_SECRET_KEY`. Application code is expected
-- to fail closed (return 503 / 500) when the key is missing or invalid; this
-- table intentionally has no `value` / `plaintext_value` columns and the
-- repository helpers must not introduce any.

CREATE TABLE env_secret_values (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON UPDATE cascade ON DELETE cascade,
  key text NOT NULL,
  scope text NOT NULL DEFAULT 'project',
  encrypted_value bytea NOT NULL,
  value_fingerprint text NOT NULL,
  key_version smallint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT env_secret_values_scope_valid CHECK (scope IN ('project', 'deployment')),
  CONSTRAINT env_secret_values_key_fingerprint_not_blank CHECK (
    length(btrim(value_fingerprint)) > 0
  ),
  CONSTRAINT env_secret_values_key_version_positive CHECK (key_version > 0)
);

CREATE UNIQUE INDEX env_secret_values_project_key_scope_unique
  ON env_secret_values (project_id, key, scope);

CREATE INDEX env_secret_values_project_id_idx
  ON env_secret_values (project_id);

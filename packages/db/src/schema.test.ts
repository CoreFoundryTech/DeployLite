import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { assertEnvMetadataHasNoValueColumns, toEnvVariableMetadataInsert } from "./env-metadata.js";
import { canonicalRoleNames } from "./schema.js";

const migrationSql = readFileSync(new URL("../migrations/0000_auth_postgres_foundation.sql", import.meta.url), "utf8");
const envSecretValuesMigrationSql = readFileSync(
  new URL("../migrations/0004_env_secret_values.sql", import.meta.url),
  "utf8"
);

describe("auth PostgreSQL schema foundation", () => {
  it("seeds only the canonical RBAC roles", () => {
    expect(canonicalRoleNames).toEqual(["admin", "operator", "read-only", "auditor"]);
    expect(canonicalRoleNames).not.toContain("owner");
    expect(canonicalRoleNames).not.toContain("viewer");

    for (const role of canonicalRoleNames) {
      expect(migrationSql).toContain(`('${role}'`);
    }
    expect(migrationSql).toContain("CONSTRAINT roles_name_canonical");
  });

  it("uses users.role_id as a DB-enforced FK with an explicit index", () => {
    expect(migrationSql).toContain("role_id uuid NOT NULL REFERENCES roles(id)");
    expect(migrationSql).toContain("CREATE INDEX users_role_id_idx ON users (role_id)");
    expect(migrationSql).not.toMatch(/\brole\s+text\b/);
  });

  it("defines checks and FK indexes for session, audit, deployment, and metadata tables", () => {
    expect(migrationSql).toContain("CONSTRAINT users_status_valid CHECK (status IN ('active', 'disabled'))");
    expect(migrationSql).toContain("CONSTRAINT deployments_status_valid CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'canceled'))");
    expect(migrationSql).toContain("CREATE INDEX user_sessions_user_id_idx ON user_sessions (user_id)");
    expect(migrationSql).toContain("CREATE INDEX deployments_project_id_idx ON deployments (project_id)");
    expect(migrationSql).toContain("CREATE INDEX audit_events_actor_user_id_idx ON audit_events (actor_user_id)");
    expect(migrationSql).toContain("CREATE INDEX env_variable_metadata_project_id_idx ON env_variable_metadata (project_id)");
  });

  it("keeps environment variables metadata-only and blocks submitted secret values", () => {
    expect(migrationSql).toContain("CREATE TABLE env_variable_metadata");
    expect(migrationSql).not.toMatch(/\b(value|secret|encrypted_value)\s+text\b/);

    expect(assertEnvMetadataHasNoValueColumns(["id", "project_id", "key", "value_present", "value_fingerprint"])).toBe(true);
    expect(() => assertEnvMetadataHasNoValueColumns(["id", "value"])).toThrow("Unsafe env value persistence column detected");
    expect(() => toEnvVariableMetadataInsert({ projectId: "project-id", key: "TOKEN", value: "plaintext" } as never)).toThrow(
      "Environment variable metadata cannot include secret value field"
    );

    expect(toEnvVariableMetadataInsert({ projectId: "project-id", key: "TOKEN" })).toMatchObject({
      projectId: "project-id",
      key: "TOKEN",
      valuePresent: false,
      valueFingerprint: null
    });
  });
});

describe("env secret values storage migration", () => {
  it("creates the env_secret_values table with the encrypted bytea column and no plaintext value field", () => {
    expect(envSecretValuesMigrationSql).toContain("CREATE TABLE env_secret_values");
    expect(envSecretValuesMigrationSql).toContain("encrypted_value bytea NOT NULL");
    expect(envSecretValuesMigrationSql).toContain("value_fingerprint text NOT NULL");
    // The table must not declare any plaintext or raw-value column. We assert
    // against the table body only (between CREATE TABLE and the closing
    // semicolon) so the surrounding SQL documentation can still mention
    // the concept of "raw values" and "plaintext values" without tripping
    // the guard.
    const tableBody = extractCreateTableBody(envSecretValuesMigrationSql, "env_secret_values");
    expect(tableBody).not.toMatch(/\bvalue\s+text\b/);
    expect(tableBody).not.toMatch(/\bplaintext_value\b/);
    expect(tableBody).not.toMatch(/\bsecret_value\s+text\b/);
    expect(tableBody).not.toMatch(/\braw_value\b/);
  });

  it("enforces a project FK, scope check, and unique project/key/scope constraint", () => {
    expect(envSecretValuesMigrationSql).toContain("REFERENCES projects(id) ON UPDATE cascade ON DELETE cascade");
    expect(envSecretValuesMigrationSql).toContain("CONSTRAINT env_secret_values_scope_valid CHECK (scope IN ('project', 'deployment'))");
    expect(envSecretValuesMigrationSql).toMatch(/CREATE UNIQUE INDEX\s+env_secret_values_project_key_scope_unique\s+ON\s+env_secret_values\s+\(project_id,\s*key,\s*scope\)/);
    expect(envSecretValuesMigrationSql).toMatch(/CREATE INDEX\s+env_secret_values_project_id_idx\s+ON\s+env_secret_values\s+\(project_id\)/);
    expect(envSecretValuesMigrationSql).toContain("CONSTRAINT env_secret_values_key_version_positive CHECK (key_version > 0)");
  });

  it("rejects blank fingerprints and is forward-only", () => {
    expect(envSecretValuesMigrationSql).toContain("CONSTRAINT env_secret_values_key_fingerprint_not_blank");
    expect(envSecretValuesMigrationSql).not.toMatch(/\bDROP\b/);
    expect(envSecretValuesMigrationSql).not.toMatch(/\bTRUNCATE\b/);
    expect(envSecretValuesMigrationSql).not.toMatch(/\bALTER\s+TABLE\s+\w+\s+RENAME\b/i);
  });
});

function extractCreateTableBody(sql: string, tableName: string): string {
  const match = sql.match(new RegExp(`CREATE TABLE ${tableName}\\s*\\(([\\s\\S]*?)\\);`));
  if (!match) {
    throw new Error(`Could not find CREATE TABLE body for ${tableName}`);
  }
  return match[1] ?? "";
}

import { and, eq } from "drizzle-orm";
import type { EnvSecretValue } from "@deploylite/contracts";
import type { EncryptedEnvSecretValueRecord, EnvSecretValueInput, EnvSecretValueRecord, EnvSecretValueRepository } from "@deploylite/domain";

import type { DeployLiteDb } from "../client.js";
import { assertEnvSecretValuesInputHasNoRawValueColumns } from "../env-metadata.js";
import { envSecretValues, type EnvSecretValueRow } from "../schema.js";

export class DbEnvSecretValueRepository implements EnvSecretValueRepository {
  constructor(private readonly db: DeployLiteDb) {}

  async listByProject(projectId: string): Promise<EnvSecretValueRecord[]> {
    const rows = await this.db.select().from(envSecretValues).where(eq(envSecretValues.projectId, projectId));
    return rows.map(toEnvSecretValue);
  }

  async listEncryptedByProject(projectId: string): Promise<EncryptedEnvSecretValueRecord[]> {
    const rows = await this.db.select().from(envSecretValues).where(eq(envSecretValues.projectId, projectId));
    return rows.map((row) => ({ ...toEnvSecretValue(row), encryptedValue: Buffer.from(row.encryptedValue) }));
  }

  async upsert(record: EnvSecretValueInput): Promise<EnvSecretValueRecord> {
    // Defense in depth: even if a future caller forgets to scrub the input,
    // the repository refuses to persist anything that looks like a raw value.
    assertEnvSecretValuesInputHasNoRawValueColumns(Object.keys(record));

    const now = new Date();
    const [row] = await this.db
      .insert(envSecretValues)
      .values({
        projectId: record.projectId,
        key: record.key,
        scope: record.scope,
        encryptedValue: record.encryptedValue,
        valueFingerprint: record.valueFingerprint,
        keyVersion: record.keyVersion,
        createdAt: now,
        updatedAt: now
      })
      .onConflictDoUpdate({
        target: [envSecretValues.projectId, envSecretValues.key, envSecretValues.scope],
        set: {
          encryptedValue: record.encryptedValue,
          valueFingerprint: record.valueFingerprint,
          keyVersion: record.keyVersion,
          updatedAt: now
        }
      })
      .returning();

    if (!row) throw new Error("Failed to upsert env secret value");
    return toEnvSecretValue(row);
  }

  async remove(projectId: string, key: string, scope: EnvSecretValue["scope"]): Promise<boolean> {
    const result = await this.db
      .delete(envSecretValues)
      .where(
        and(
          eq(envSecretValues.projectId, projectId),
          eq(envSecretValues.key, key),
          eq(envSecretValues.scope, scope)
        )
      )
      .returning({ id: envSecretValues.id });
    return result.length > 0;
  }
}

function toEnvSecretValue(row: EnvSecretValueRow): EnvSecretValueRecord {
  return {
    id: row.id,
    projectId: row.projectId,
    key: row.key,
    scope: row.scope === "deployment" ? "deployment" : "project",
    valuePresent: true,
    valueFingerprint: row.valueFingerprint,
    keyVersion: row.keyVersion,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  };
}

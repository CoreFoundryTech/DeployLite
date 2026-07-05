import { and, eq } from "drizzle-orm";
import type { EnvVariableMetadata } from "@deploylite/contracts";
import type { EnvVariableMetadataRecord, EnvVariableMetadataRepository } from "@deploylite/domain";

import type { DeployLiteDb } from "../client.js";
import { envVariableMetadata } from "../schema.js";

export class DbEnvVariableMetadataRepository implements EnvVariableMetadataRepository {
  constructor(private readonly db: DeployLiteDb) {}

  async listByProject(projectId: string): Promise<EnvVariableMetadataRecord[]> {
    const rows = await this.db.select().from(envVariableMetadata).where(eq(envVariableMetadata.projectId, projectId));
    return rows.map(toEnvVariableMetadata);
  }

  async upsert(record: EnvVariableMetadataRecord): Promise<EnvVariableMetadataRecord> {
    const [row] = await this.db
      .insert(envVariableMetadata)
      .values({
        projectId: record.projectId,
        key: record.key,
        scope: record.scope,
        valuePresent: record.valuePresent,
        valueFingerprint: record.valueFingerprint,
        required: record.required,
        description: record.description
      })
      .onConflictDoUpdate({
        target: [envVariableMetadata.projectId, envVariableMetadata.key, envVariableMetadata.scope],
        set: {
          valuePresent: record.valuePresent,
          valueFingerprint: record.valueFingerprint,
          required: record.required,
          description: record.description,
          updatedAt: new Date()
        }
      })
      .returning();

    if (!row) throw new Error("Failed to upsert env variable metadata");
    return toEnvVariableMetadata(row);
  }

  async remove(projectId: string, key: string, scope: EnvVariableMetadata["scope"]): Promise<boolean> {
    const result = await this.db
      .delete(envVariableMetadata)
      .where(and(eq(envVariableMetadata.projectId, projectId), eq(envVariableMetadata.key, key), eq(envVariableMetadata.scope, scope)))
      .returning({ id: envVariableMetadata.id });
    return result.length > 0;
  }
}

type EnvMetadataRow = typeof envVariableMetadata.$inferSelect;

function toEnvVariableMetadata(row: EnvMetadataRow): EnvVariableMetadataRecord {
  return {
    id: row.id,
    projectId: row.projectId,
    key: row.key,
    scope: row.scope === "deployment" ? "deployment" : "project",
    valuePresent: row.valuePresent,
    valueFingerprint: row.valueFingerprint,
    required: row.required,
    description: row.description,
    updatedAt: row.updatedAt.toISOString()
  };
}

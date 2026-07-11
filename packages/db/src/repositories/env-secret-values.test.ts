import type { EnvSecretValueInput } from "@deploylite/domain";
import { describe, expect, it } from "vitest";

import { DbEnvSecretValueRepository } from "./env-secret-values.js";
import type { EnvSecretValueRow } from "../schema.js";

/**
 * Minimal in-memory fake of the Drizzle query builder chain used by
 * `DbEnvSecretValueRepository`. The production Drizzle client speaks
 * PostgreSQL; here we just want to confirm that:
 *
 *   - the `encryptedValue` column is allowed through the guard at the DB
 *     boundary (it is *not* allowed at the env metadata boundary), and
 *   - the encrypted bytea is actually written through to the underlying
 *     `values()` payload so a future caller cannot accidentally drop it.
 *
 * If the guard ever regresses and starts blocking `encryptedValue`, the
 * `upsert` call will throw before reaching the captured payload.
 */

type CapturedInsert = {
  values: Record<string, unknown>;
  onConflict: { target: unknown; set: Record<string, unknown> } | null;
};

function createFakeDb(returning: EnvSecretValueRow) {
  const captured: { inserts: CapturedInsert[]; deletes: unknown[] } = { inserts: [], deletes: [] };
  const query = {
    values(payload: Record<string, unknown>) {
      captured.inserts.push({ values: payload, onConflict: null });
      return {
        onConflictDoUpdate(config: { target: unknown; set: Record<string, unknown> }) {
          const last = captured.inserts.at(-1);
          if (last) last.onConflict = config;
          return {
            returning: async () => [returning]
          };
        }
      };
    }
  };
  const db = {
    insert: () => query,
    select: () => ({
      from: () => ({
        where: async () => [returning]
      })
    }),
    delete: () => ({
      where: () => ({
        returning: async (projection: { id: unknown }) => {
          captured.deletes.push(projection);
          return [{ id: returning.id }];
        }
      })
    })
  };
  return { db, captured };
}

const baseRow: EnvSecretValueRow = {
  id: "00000000-0000-0000-0000-000000000001",
  projectId: "00000000-0000-0000-0000-000000000002",
  key: "DATABASE_URL",
  scope: "project",
  encryptedValue: Buffer.from("encrypted-blob", "utf8"),
  valueFingerprint: "0123456789abcdef0123456789abcdef",
  keyVersion: 1,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z")
};

describe("DbEnvSecretValueRepository DB boundary", () => {
  it("exposes ciphertext only through the internal materialization port", async () => {
    const { db } = createFakeDb(baseRow);
    const repo = new DbEnvSecretValueRepository(db as never);

    const [record] = await repo.listEncryptedByProject(baseRow.projectId);

    expect(record).toMatchObject({ projectId: baseRow.projectId, key: baseRow.key, scope: "project", keyVersion: 1 });
    expect(record?.encryptedValue.toString("utf8")).toBe("encrypted-blob");
    expect(record).not.toHaveProperty("value");
    expect(record).not.toHaveProperty("plaintext");
  });

  it("persists the encryptedValue bytea payload to the database adapter", async () => {
    const { db, captured } = createFakeDb(baseRow);
    const repo = new DbEnvSecretValueRepository(db as never);

    const payload: EnvSecretValueInput = {
      projectId: baseRow.projectId,
      key: baseRow.key,
      scope: "project",
      encryptedValue: Buffer.from("encrypted-blob", "utf8"),
      valueFingerprint: baseRow.valueFingerprint,
      keyVersion: 1
    };

    const result = await repo.upsert(payload);

    expect(result).toMatchObject({
      id: baseRow.id,
      projectId: baseRow.projectId,
      key: baseRow.key,
      valuePresent: true,
      valueFingerprint: baseRow.valueFingerprint,
      keyVersion: 1
    });

    expect(captured.inserts).toHaveLength(1);
    const [insert] = captured.inserts;
    expect(insert).toBeDefined();
    expect(insert!.values).toMatchObject({
      projectId: baseRow.projectId,
      key: baseRow.key,
      scope: "project",
      valueFingerprint: baseRow.valueFingerprint,
      keyVersion: 1
    });
    // The encrypted bytea must reach the values() payload intact; the guard
    // is only allowed to block raw/plaintext columns, never this one.
    expect(insert!.values["encryptedValue"]).toBeInstanceOf(Buffer);
    expect((insert!.values["encryptedValue"] as Buffer).toString("utf8")).toBe("encrypted-blob");
    // The onConflictDoUpdate.set must also include the encryptedValue column
    // so a subsequent write rotates the bytea in place.
    expect(insert!.onConflict?.set["encryptedValue"]).toBeInstanceOf(Buffer);
  });

  it("refuses to upsert an input that smuggles a plaintext value column", async () => {
    const { db } = createFakeDb(baseRow);
    const repo = new DbEnvSecretValueRepository(db as never);

    const payload = {
      projectId: baseRow.projectId,
      key: baseRow.key,
      scope: "project",
      encryptedValue: Buffer.from("encrypted-blob", "utf8"),
      valueFingerprint: baseRow.valueFingerprint,
      keyVersion: 1,
      value: "plaintext-smuggled" as unknown as never
    } satisfies EnvSecretValueInput & { value: string };

    await expect(repo.upsert(payload)).rejects.toThrow("Unsafe raw env secret value persistence column detected: value");
  });

  it("refuses to upsert an input that smuggles a plaintext snake_case column", async () => {
    const { db } = createFakeDb(baseRow);
    const repo = new DbEnvSecretValueRepository(db as never);

    const payload = {
      projectId: baseRow.projectId,
      key: baseRow.key,
      scope: "project",
      encryptedValue: Buffer.from("encrypted-blob", "utf8"),
      valueFingerprint: baseRow.valueFingerprint,
      keyVersion: 1,
      plaintext_value: "smuggled" as unknown as never
    } satisfies EnvSecretValueInput & { plaintext_value: string };

    await expect(repo.upsert(payload)).rejects.toThrow(
      "Unsafe raw env secret value persistence column detected: plaintext_value"
    );
  });
});

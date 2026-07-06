import { describe, expect, it } from "vitest";

import { InMemoryEnvSecretValueRepository, type EnvSecretValueInput } from "./index.js";

function encryptedValue(blob: string): Buffer {
  return Buffer.from(blob, "utf8");
}

describe("InMemoryEnvSecretValueRepository", () => {
  it("upserts a record and returns a metadata-only view (no encrypted value field)", async () => {
    const repo = new InMemoryEnvSecretValueRepository();
    const input: EnvSecretValueInput = {
      projectId: "project_1",
      key: "DATABASE_URL",
      scope: "project",
      encryptedValue: encryptedValue("ciphertext-1"),
      valueFingerprint: "deadbeefdeadbeefdeadbeefdeadbeef",
      keyVersion: 1
    };

    const saved = await repo.upsert(input);
    expect(saved.id).toMatch(/^envv_/);
    expect(saved).toMatchObject({
      projectId: "project_1",
      key: "DATABASE_URL",
      scope: "project",
      valuePresent: true,
      valueFingerprint: "deadbeefdeadbeefdeadbeefdeadbeef",
      keyVersion: 1
    });
    expect(Object.keys(saved)).not.toContain("encryptedValue");
    expect(Object.keys(saved)).not.toContain("value");
    expect(Object.keys(saved)).not.toContain("plaintextValue");
  });

  it("preserves the original id and createdAt on subsequent upserts", async () => {
    const repo = new InMemoryEnvSecretValueRepository();
    const first = await repo.upsert({
      projectId: "project_1",
      key: "API_KEY",
      scope: "project",
      encryptedValue: encryptedValue("ciphertext-1"),
      valueFingerprint: "f".repeat(32),
      keyVersion: 1
    });
    const second = await repo.upsert({
      projectId: "project_1",
      key: "API_KEY",
      scope: "project",
      encryptedValue: encryptedValue("ciphertext-2"),
      valueFingerprint: "a".repeat(32),
      keyVersion: 1
    });

    expect(second.id).toBe(first.id);
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.updatedAt >= first.updatedAt).toBe(true);
    expect(second.valueFingerprint).toBe("a".repeat(32));
  });

  it("isolates records by (project, key, scope) tuple", async () => {
    const repo = new InMemoryEnvSecretValueRepository();
    await repo.upsert({
      projectId: "project_1",
      key: "API_KEY",
      scope: "project",
      encryptedValue: encryptedValue("project-1-project"),
      valueFingerprint: "1".repeat(32),
      keyVersion: 1
    });
    await repo.upsert({
      projectId: "project_1",
      key: "API_KEY",
      scope: "deployment",
      encryptedValue: encryptedValue("project-1-deployment"),
      valueFingerprint: "2".repeat(32),
      keyVersion: 1
    });
    await repo.upsert({
      projectId: "project_2",
      key: "API_KEY",
      scope: "project",
      encryptedValue: encryptedValue("project-2-project"),
      valueFingerprint: "3".repeat(32),
      keyVersion: 1
    });

    const projectOne = await repo.listByProject("project_1");
    expect(projectOne).toHaveLength(2);
    const projectTwo = await repo.listByProject("project_2");
    expect(projectTwo).toHaveLength(1);
  });

  it("removes a record and reports the boolean outcome", async () => {
    const repo = new InMemoryEnvSecretValueRepository();
    await repo.upsert({
      projectId: "project_1",
      key: "API_KEY",
      scope: "project",
      encryptedValue: encryptedValue("ciphertext"),
      valueFingerprint: "b".repeat(32),
      keyVersion: 1
    });

    expect(await repo.remove("project_1", "API_KEY", "project")).toBe(true);
    expect(await repo.remove("project_1", "API_KEY", "project")).toBe(false);
    expect(await repo.listByProject("project_1")).toHaveLength(0);
  });

  it("rejects inputs that omit the encrypted buffer or fingerprint", async () => {
    const repo = new InMemoryEnvSecretValueRepository();

    await expect(
      repo.upsert({
        projectId: "project_1",
        key: "API_KEY",
        scope: "project",
        encryptedValue: Buffer.alloc(0),
        valueFingerprint: "b".repeat(32),
        keyVersion: 1
      })
    ).rejects.toThrow(/encryptedValue/);

    await expect(
      repo.upsert({
        projectId: "project_1",
        key: "API_KEY",
        scope: "project",
        encryptedValue: encryptedValue("ciphertext"),
        valueFingerprint: "",
        keyVersion: 1
      })
    ).rejects.toThrow(/valueFingerprint/);

    await expect(
      repo.upsert({
        projectId: "project_1",
        key: "API_KEY",
        scope: "project",
        encryptedValue: encryptedValue("ciphertext"),
        valueFingerprint: "b".repeat(32),
        keyVersion: 0
      })
    ).rejects.toThrow(/keyVersion/);
  });
});

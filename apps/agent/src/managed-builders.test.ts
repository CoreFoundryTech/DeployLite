import { createHmac } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileManagedBuilderRegistry, ManagedBuilderRegistryRecoveryError } from "./managed-builders.js";

const directories: string[] = [];
const integrityKey = "test-registry-integrity-key-0123456789abcdef";
const previousIntegrityKey = "previous-registry-integrity-key-012345678";
const fixedNow = () => new Date("2026-07-10T12:00:00.000Z");
async function pathFor() { const directory = await mkdtemp(join(tmpdir(), "deploylite-builders-")); directories.push(directory); return join(directory, "builders.json"); }
function registry(path: string, key = integrityKey, previousKey?: string, afterWrite?: (path: string) => void | Promise<void>) { return new FileManagedBuilderRegistry(path, key, fixedNow, previousKey, afterWrite); }
async function put(path: string, commandId = "command-1") { await registry(path).put({ version: 1, commandId, builderName: `deploylite-${commandId}` }); }
async function putTwo(path: string) { await put(path); await registry(path).put({ version: 1, commandId: "command-2", builderName: "deploylite-command-2" }); }
function legacyFile(entries: Array<{ version: 1; commandId: string; builderName: string; registeredAt: string; updatedAt: string }>, key = integrityKey): string {
  const unsigned = { version: 2 as const, keyVersion: 1 as const, entries };
  return JSON.stringify({ ...unsigned, mac: createHmac("sha256", key).update(JSON.stringify(unsigned), "utf8").digest("hex") });
}
function legacyEntry(commandId: string) { return { version: 1 as const, commandId, builderName: `deploylite-${commandId}`, registeredAt: "2026-07-09T12:00:00.000Z", updatedAt: "2026-07-09T12:00:00.000Z" }; }
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

describe("FileManagedBuilderRegistry", () => {
  it("persists authenticated generation-stamped builders with mode 0600 and survives restart", async () => {
    const path = await pathFor();
    await put(path);
    await expect(registry(path).load()).resolves.toHaveLength(1);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(`${path}.backup`)).mode & 0o777).toBe(0o600);
    const persisted = await readFile(path, "utf8");
    expect(persisted).toContain('"version":3');
    expect(persisted).toContain('"generation":1');
    expect(persisted).toContain('"mac":');
    expect(persisted).not.toContain(integrityKey);
  });

  it("chooses the newest authenticated copy and repairs a corrupt or stale primary without losing builders", async () => {
    const path = await pathFor();
    await put(path);
    const generationOne = await readFile(path, "utf8");
    await registry(path).put({ version: 1, commandId: "command-2", builderName: "deploylite-command-2" });
    await writeFile(path, generationOne);
    await expect(registry(path).load()).resolves.toHaveLength(2);
    expect(await readFile(path, "utf8")).toBe(await readFile(`${path}.backup`, "utf8"));
    await writeFile(path, "tampered-primary");
    await expect(registry(path).load()).resolves.toHaveLength(2);
    expect(await readFile(path, "utf8")).toBe(await readFile(`${path}.backup`, "utf8"));
  });

  it("repairs a corrupt backup from the newest authenticated primary", async () => {
    const path = await pathFor();
    await putTwo(path);
    await writeFile(`${path}.backup`, "tampered-backup");
    await expect(registry(path).load()).resolves.toHaveLength(2);
    expect(await readFile(path, "utf8")).toBe(await readFile(`${path}.backup`, "utf8"));
  });

  it("survives an interruption after the first latest-generation copy is written", async () => {
    const path = await pathFor();
    await put(path);
    let writes = 0;
    const interrupted = registry(path, integrityKey, undefined, () => { if (++writes === 1) throw new Error("simulated crash"); });
    await expect(interrupted.put({ version: 1, commandId: "command-2", builderName: "deploylite-command-2" })).rejects.toThrow("simulated crash");
    await expect(registry(path).load()).resolves.toHaveLength(2);
    expect(await readFile(path, "utf8")).toBe(await readFile(`${path}.backup`, "utf8"));
  });

  it("fails closed on rollback-resistant equal-generation divergence", async () => {
    const left = await pathFor();
    const right = await pathFor();
    await put(left, "command-a");
    await put(right, "command-b");
    await writeFile(`${left}.backup`, await readFile(right, "utf8"));
    await expect(registry(left).load()).rejects.toBeInstanceOf(ManagedBuilderRegistryRecoveryError);
    await expect(readFile(`${left}.recovery-required`, "utf8")).resolves.toBe("version=1\n");
  });

  it("persists a bounded, mode-0600 recovery marker and remains fail-closed after copies disappear", async () => {
    const path = await pathFor();
    await put(path);
    await writeFile(path, "tampered-primary");
    await writeFile(`${path}.backup`, "tampered-backup");
    await expect(registry(path).load()).rejects.toBeInstanceOf(ManagedBuilderRegistryRecoveryError);
    const marker = `${path}.recovery-required`;
    expect(await readFile(marker, "utf8")).toBe("version=1\n");
    expect((await stat(marker)).mode & 0o777).toBe(0o600);
    expect((await readdir(join(path, ".."))).some((file) => file.startsWith("builders.json.corrupt-"))).toBe(true);
    await rm(path, { force: true });
    await rm(`${path}.backup`, { force: true });
    await expect(registry(path).load()).rejects.toBeInstanceOf(ManagedBuilderRegistryRecoveryError);
    await expect(registry(path).load()).rejects.toBeInstanceOf(ManagedBuilderRegistryRecoveryError);
  });

  it("only clears a recovery marker after a valid authenticated restore and rejects corrupt markers", async () => {
    const path = await pathFor();
    await put(path);
    const valid = await readFile(path, "utf8");
    await writeFile(path, "tampered-primary");
    await writeFile(`${path}.backup`, "tampered-backup");
    await expect(registry(path).load()).rejects.toBeInstanceOf(ManagedBuilderRegistryRecoveryError);
    await writeFile(path, valid);
    await expect(registry(path).load()).resolves.toHaveLength(1);
    await expect(readFile(`${path}.recovery-required`, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await writeFile(`${path}.recovery-required`, "corrupt");
    await expect(registry(path).load()).rejects.toBeInstanceOf(ManagedBuilderRegistryRecoveryError);
  });

  it("treats a fresh install without copies or marker as empty", async () => {
    await expect(registry(await pathFor()).load()).resolves.toEqual([]);
  });

  it("requires a dedicated strong integrity key and supports one-way authenticated key rotation", async () => {
    const path = await pathFor();
    expect(() => registry(path, "weak")).toThrow("between 32 and 4096 bytes");
    await registry(path, previousIntegrityKey).put({ version: 1, commandId: "command-1", builderName: "deploylite-command-1" });
    await expect(registry(path, integrityKey).load()).rejects.toBeInstanceOf(ManagedBuilderRegistryRecoveryError);
    await expect(registry(path, integrityKey, previousIntegrityKey).load()).resolves.toHaveLength(1);
    await expect(registry(path, integrityKey).load()).resolves.toHaveLength(1);
    await expect(registry(path, "another-registry-integrity-key-0123456789").load()).rejects.toBeInstanceOf(ManagedBuilderRegistryRecoveryError);
  });

  it("survives an interruption during previous-key re-signing", async () => {
    const path = await pathFor();
    await registry(path, previousIntegrityKey).put({ version: 1, commandId: "command-1", builderName: "deploylite-command-1" });
    let writes = 0;
    await expect(registry(path, integrityKey, previousIntegrityKey, () => { if (++writes === 1) throw new Error("simulated rotation crash"); }).load()).rejects.toThrow("simulated rotation crash");
    await expect(registry(path, integrityKey, previousIntegrityKey).load()).resolves.toHaveLength(1);
    await expect(registry(path, integrityKey).load()).resolves.toHaveLength(1);
  });

  it("does not couple registry evidence to a rotated agent bearer token", async () => {
    const path = await pathFor();
    await put(path);
    const oldAgentToken = "agent-token-before-rotation-0123456789abcdef";
    const newAgentToken = "agent-token-after-rotation-0123456789abcdef";
    expect(oldAgentToken).not.toBe(newAgentToken);
    await expect(registry(path, integrityKey).load()).resolves.toHaveLength(1);
  });

  it("migrates a valid v2 primary over an older valid v2 backup to deterministic v3 copies", async () => {
    const path = await pathFor();
    await writeFile(path, legacyFile([legacyEntry("command-2")]));
    await writeFile(`${path}.backup`, legacyFile([legacyEntry("command-1")]));
    await expect(registry(path).load()).resolves.toEqual([legacyEntry("command-2")]);
    for (const candidate of [path, `${path}.backup`]) {
      const persisted = await readFile(candidate, "utf8");
      expect(persisted).toContain('"version":3');
      expect(persisted).toContain('"generation":1');
    }
  });

  it("migrates an authenticated v2 backup when the v2 primary is corrupt", async () => {
    const path = await pathFor();
    await writeFile(path, "corrupt-primary");
    await writeFile(`${path}.backup`, legacyFile([legacyEntry("command-1")]));
    await expect(registry(path).load()).resolves.toEqual([legacyEntry("command-1")]);
    expect(await readFile(path, "utf8")).toBe(await readFile(`${path}.backup`, "utf8"));
  });

  it("re-signs previous-key v2 evidence with the current key", async () => {
    const path = await pathFor();
    await writeFile(path, legacyFile([legacyEntry("command-1")], previousIntegrityKey));
    await writeFile(`${path}.backup`, legacyFile([legacyEntry("command-1")], previousIntegrityKey));
    await expect(registry(path, integrityKey, previousIntegrityKey).load()).resolves.toHaveLength(1);
    await expect(registry(path, integrityKey).load()).resolves.toHaveLength(1);
  });

  it("rejects invalid-HMAC and schema-tampered v2 files without migration", async () => {
    const path = await pathFor();
    const valid = legacyFile([legacyEntry("command-1")]);
    await writeFile(path, valid.replace("command-1", "command-2"));
    await writeFile(`${path}.backup`, valid.replace('"keyVersion":1', '"keyVersion":2'));
    await expect(registry(path).load()).rejects.toBeInstanceOf(ManagedBuilderRegistryRecoveryError);
    await expect(readFile(`${path}.recovery-required`, "utf8")).resolves.toBe("version=1\n");
  });

  it("resumes v2 migration after interruption at either v3 copy", async () => {
    for (const interruptedWrite of [1, 2]) {
      const path = await pathFor();
      await writeFile(path, legacyFile([legacyEntry("command-1")]));
      await writeFile(`${path}.backup`, legacyFile([legacyEntry("command-1")]));
      let writes = 0;
      await expect(registry(path, integrityKey, undefined, () => { if (++writes === interruptedWrite) throw new Error("simulated migration crash"); }).load()).rejects.toThrow("simulated migration crash");
      await expect(registry(path).load()).resolves.toEqual([legacyEntry("command-1")]);
      expect(await readFile(path, "utf8")).toBe(await readFile(`${path}.backup`, "utf8"));
    }
  });

  it("keeps a recovery marker until v2 migration has verified both v3 copies", async () => {
    const path = await pathFor();
    await writeFile(path, legacyFile([legacyEntry("command-1")]));
    await writeFile(`${path}.backup`, legacyFile([legacyEntry("command-1")]));
    await writeFile(`${path}.recovery-required`, "version=1\n");
    let writes = 0;
    await expect(registry(path, integrityKey, undefined, () => { if (++writes === 2) throw new Error("simulated migration crash"); }).load()).rejects.toThrow("simulated migration crash");
    await expect(readFile(`${path}.recovery-required`, "utf8")).resolves.toBe("version=1\n");
    await expect(registry(path).load()).resolves.toHaveLength(1);
    await expect(readFile(`${path}.recovery-required`, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not rewrite already-v3 evidence as a legacy migration", async () => {
    const path = await pathFor();
    await put(path);
    let writes = 0;
    await expect(registry(path, integrityKey, undefined, () => { writes += 1; }).load()).resolves.toHaveLength(1);
    expect(writes).toBe(0);
  });
});

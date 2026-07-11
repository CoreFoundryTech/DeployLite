import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileManagedBuilderRegistry, ManagedBuilderRegistryRecoveryError } from "./managed-builders.js";

const directories: string[] = [];
const integrityKey = "test-registry-integrity-key";
const fixedNow = () => new Date("2026-07-10T12:00:00.000Z");
async function pathFor() { const directory = await mkdtemp(join(tmpdir(), "deploylite-builders-")); directories.push(directory); return join(directory, "builders.json"); }
function registry(path: string, key = integrityKey) { return new FileManagedBuilderRegistry(path, key, fixedNow); }
async function put(path: string, commandId = "command-1") { await registry(path).put({ version: 1, commandId, builderName: `deploylite-${commandId}` }); }
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

describe("FileManagedBuilderRegistry", () => {
  it("persists authenticated, timestamped deterministic builders with mode 0600 and survives restart", async () => {
    const path = await pathFor();
    await put(path);
    await expect(registry(path).load()).resolves.toEqual([{ version: 1, commandId: "command-1", builderName: "deploylite-command-1", registeredAt: "2026-07-10T12:00:00.000Z", updatedAt: "2026-07-10T12:00:00.000Z" }]);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(`${path}.backup`)).mode & 0o777).toBe(0o600);
    const persisted = await readFile(path, "utf8");
    expect(persisted).toContain('"version":2');
    expect(persisted).toContain('"mac":');
    expect(persisted).not.toContain(integrityKey);
  });

  it("recovers a corrupt or missing primary from an authenticated backup", async () => {
    const path = await pathFor();
    await put(path);
    await writeFile(path, "tampered");
    await expect(registry(path).load()).resolves.toHaveLength(1);
    expect(await readFile(path, "utf8")).toBe(await readFile(`${path}.backup`, "utf8"));
    await rm(path);
    await expect(registry(path).load()).resolves.toHaveLength(1);
  });

  it("accepts a valid primary when the backup is corrupt", async () => {
    const path = await pathFor();
    await put(path);
    await writeFile(`${path}.backup`, "tampered");
    await expect(registry(path).load()).resolves.toHaveLength(1);
  });

  it("fails closed, quarantines corruption, and writes a content-free recovery marker when redundant copies are invalid", async () => {
    const path = await pathFor();
    await put(path);
    await writeFile(path, "tampered-primary");
    await writeFile(`${path}.backup`, "tampered-backup");
    await expect(registry(path).load()).rejects.toBeInstanceOf(ManagedBuilderRegistryRecoveryError);
    expect(await readFile(`${path}.recovery-required`, "utf8")).toBe("version=1\n");
    expect((await readdir(join(path, ".."))).some((file) => file.startsWith("builders.json.corrupt-"))).toBe(true);
  });

  it("rejects checksum tampering, schema mismatches, and wrong integrity keys", async () => {
    const path = await pathFor();
    await put(path);
    const valid = await readFile(path, "utf8");
    await writeFile(path, valid.replace("command-1", "command-2"));
    await expect(registry(path).load()).resolves.toHaveLength(1);
    await writeFile(path, valid.replace('"version":2', '"version":99'));
    await expect(registry(path).load()).resolves.toHaveLength(1);
    await expect(registry(path, "wrong-key").load()).rejects.toBeInstanceOf(ManagedBuilderRegistryRecoveryError);
  });

  it("rotates backup only from a verified primary before atomically replacing the primary", async () => {
    const path = await pathFor();
    await put(path, "command-1");
    const firstPrimary = await readFile(path, "utf8");
    await registry(path).put({ version: 1, commandId: "command-2", builderName: "deploylite-command-2" });
    expect(await readFile(`${path}.backup`, "utf8")).toBe(firstPrimary);
    expect(await registry(path).load()).toHaveLength(2);
  });

  it("ignores interrupted temporary writes and validates duplicate, bounded, spoofed, and sensitive inputs", async () => {
    const path = await pathFor();
    await put(path);
    await writeFile(`${path}.tmp-interrupted`, "partial");
    await expect(registry(path).load()).resolves.toHaveLength(1);
    await registry(path).put({ version: 1, commandId: "command-1", builderName: "deploylite-command-1" });
    await expect(registry(path).load()).resolves.toHaveLength(1);
    await expect(registry(path).put({ version: 1, commandId: "command-2", builderName: "deploylite-spoof" })).rejects.toThrow("does not match");
    await expect(registry(path).put({ version: 1, commandId: "command_secret", builderName: "deploylite-command_secret" })).rejects.toThrow();
    for (let index = 2; index <= 256; index += 1) await registry(path).put({ version: 1, commandId: `command-${index}`, builderName: `deploylite-command-${index}` });
    await expect(registry(path).put({ version: 1, commandId: "command-257", builderName: "deploylite-command-257" })).rejects.toThrow("full");
    expect(await readFile(path, "utf8")).not.toContain("command_secret");
  }, 30_000);
});

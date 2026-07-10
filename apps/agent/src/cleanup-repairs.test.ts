import { chmod, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CorruptCleanupRepairStoreError, FileCleanupRepairStore } from "./cleanup-repairs.js";

const directories: string[] = [];
const repair = { version: 1 as const, commandId: "command-1", projectSlug: "project-1" };

afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

async function pathFor(name: string) {
  const directory = await mkdtemp(join(tmpdir(), "deploylite-repairs-"));
  directories.push(directory);
  return join(directory, name);
}

describe("FileCleanupRepairStore", () => {
  it.each(["{not-json", JSON.stringify({ version: 2, records: [] }), JSON.stringify({ version: 1, records: Array.from({ length: 257 }, () => repair) })])(
    "quarantines malformed repair state and resumes with an empty store", async (contents) => {
      const path = await pathFor("repairs.json");
      await writeFile(path, contents, { mode: 0o644 });
      const store = new FileCleanupRepairStore(path);
      await expect(store.load()).resolves.toEqual([]);
      const entries = await readdir((await import("node:path")).dirname(path));
      const quarantine = entries.find((entry) => entry.startsWith("repairs.json.corrupt-"));
      expect(quarantine).toBeDefined();
      expect((await stat(join((await import("node:path")).dirname(path), quarantine!))).mode & 0o777).toBe(0o600);
      await store.put(repair);
      expect(await store.load()).toEqual([repair]);
    }
  );

  it("quarantines oversized state without exposing its contents", async () => {
    const path = await pathFor("repairs.json");
    const secret = "TOKEN=do-not-log";
    await writeFile(path, secret.repeat(20_000));
    const store = new FileCleanupRepairStore(path);
    await expect(store.load()).resolves.toEqual([]);
    const entries = await readdir((await import("node:path")).dirname(path));
    const quarantine = entries.find((entry) => entry.startsWith("repairs.json.corrupt-"));
    expect(await readFile(join((await import("node:path")).dirname(path), quarantine!), "utf8")).toContain(secret);
  });

  it("persists an empty recovery marker after quarantine without reusing corrupt records", async () => {
    const path = await pathFor("repairs.json");
    await writeFile(path, JSON.stringify({ version: 1, records: [repair], recoveryPending: "forged", token: "never-reuse" }), { mode: 0o644 });
    const store = new FileCleanupRepairStore(path);

    await expect(store.load()).resolves.toEqual([]);
    await expect(store.recoveryRequired()).resolves.toBe(true);
    const reset = await readFile(path, "utf8");
    expect(reset).toBe(JSON.stringify({ version: 1, records: [], recoveryPending: true }));
    expect(reset).not.toContain("never-reuse");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("fails closed when quarantine cannot complete", async () => {
    const path = await pathFor("repairs.json");
    await writeFile(path, "{not-json");
    const directory = (await import("node:path")).dirname(path);
    await chmod(directory, 0o500);
    try {
      await expect(new FileCleanupRepairStore(path).load()).rejects.toBeInstanceOf(CorruptCleanupRepairStoreError);
    } finally {
      await chmod(directory, 0o700);
    }
  });
});

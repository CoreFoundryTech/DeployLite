import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileManagedBuilderRegistry } from "./managed-builders.js";

const directories: string[] = [];
async function pathFor() { const directory = await mkdtemp(join(tmpdir(), "deploylite-builders-")); directories.push(directory); return join(directory, "builders.json"); }
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

describe("FileManagedBuilderRegistry", () => {
  it("atomically persists only deterministic builders and survives restart", async () => {
    const path = await pathFor();
    const registry = new FileManagedBuilderRegistry(path);
    await registry.put({ version: 1, commandId: "command-1", builderName: "deploylite-command-1" });
    await expect(new FileManagedBuilderRegistry(path).load()).resolves.toEqual([{ version: 1, commandId: "command-1", builderName: "deploylite-command-1" }]);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    await expect(registry.put({ version: 1, commandId: "command-1", builderName: "deploylite-spoof" })).rejects.toThrow("does not match");
  });

  it("quarantines corrupt state without trusting a spoofed builder", async () => {
    const path = await pathFor();
    await writeFile(path, JSON.stringify({ version: 1, entries: [{ version: 1, commandId: "command-1", builderName: "spoof" }] }));
    await expect(new FileManagedBuilderRegistry(path).load()).resolves.toEqual([]);
    expect(await readFile(path, "utf8")).toBe(JSON.stringify({ version: 1, entries: [] }));
  });
});

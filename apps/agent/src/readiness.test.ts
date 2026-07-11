import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileAgentReadiness } from "./readiness.js";

describe("FileAgentReadiness", () => {
  it("exposes only local opaque ready state and removes it when cleared", async () => {
    const directory = await mkdtemp(join(tmpdir(), "deploylite-readiness-"));
    const path = join(directory, "state", "agent-ready");
    const readiness = new FileAgentReadiness(path);
    try {
      await readiness.markReady();
      await expect(readFile(path, "utf8")).resolves.toBe("ready\n");
      await readiness.clear();
      await expect(access(path)).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

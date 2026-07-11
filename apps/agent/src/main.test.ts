import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runAgentEntrypoint } from "./main.js";
import { FileAgentReadiness } from "./readiness.js";

describe("agent process entrypoint readiness", () => {
  it("removes persisted readiness before invalid configuration or integrity-key validation can fail", async () => {
    const directory = await mkdtemp(join(tmpdir(), "deploylite-agent-startup-"));
    const readinessPath = join(directory, "agent-ready");
    const secret = "registry-key-that-must-not-appear-in-startup-errors";
    try {
      await new FileAgentReadiness(readinessPath).markReady();

      const failure = runAgentEntrypoint({
        DEPLOYLITE_AGENT_READINESS_PATH: readinessPath,
        DEPLOYLITE_AGENT_BUILDER_REGISTRY_INTEGRITY_KEY: secret.slice(0, 8)
      });

      await expect(failure).rejects.toThrow();
      await expect(access(readinessPath)).rejects.toThrow();
      await expect(failure).rejects.not.toThrow(secret);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

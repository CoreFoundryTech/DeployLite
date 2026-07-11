import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createFetchHealthProbe, runAgentEntrypoint } from "./main.js";
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

  it("aborts a production health fetch as soon as the execution signal aborts", async () => {
    const execution = new AbortController();
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    }));
    const probe = createFetchHealthProbe(fetchImpl as typeof fetch);
    const pending = probe.probe("http://runtime.test/health", 60_000, execution.signal);
    execution.abort();

    await expect(pending).resolves.toBe(false);
    expect(fetchImpl).toHaveBeenCalledWith("http://runtime.test/health", expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });
});

import { describe, expect, it, vi } from "vitest";
import type { DeploymentCommand } from "@deploylite/contracts";
import { AgentWorker, HttpAgentCommandTransport, type AgentCommandTransport } from "./worker.js";

const command: DeploymentCommand = {
  id: "command-1", deploymentId: "deployment-1", agentId: "agent-1", kind: "start", state: "pending", payload: {}, requestedBy: null,
  requestId: "request-1", correlationId: "correlation-1", issuedAt: "2026-01-01T00:00:00.000Z", claimedAt: null, completedAt: null, failureReason: null
};
const input = {
  command,
  repoUrl: "https://github.com/acme/service.git",
  ref: "main",
  projectSlug: "service",
  envFile: { contents: "TOKEN=super-secret" },
  healthUrl: "http://service:3000/health"
};

describe("AgentWorker", () => {
  it("polls through the injected transport, executes one command, and stops gracefully", async () => {
    const shutdown = new AbortController();
    const transport: AgentCommandTransport = {
      poll: vi.fn(async () => input),
      claim: vi.fn(async () => ({ ...command, state: "claimed" as const })),
      complete: vi.fn(async () => null),
      fail: vi.fn(async () => null)
    };
    const executor = {
      execute: vi.fn(async () => {
        shutdown.abort();
        return { ok: true, dryRun: false, commands: [] };
      })
    };
    const worker = new AgentWorker({ agentId: "agent-1", transport, executor, retryDelayMs: 0 });

    await worker.run(shutdown.signal);

    expect(transport.poll).toHaveBeenCalledWith("agent-1", shutdown.signal);
    expect(executor.execute).toHaveBeenCalledWith(input);
  });

  it("does not execute a command routed to another agent", async () => {
    const shutdown = new AbortController();
    const transport: AgentCommandTransport = {
      poll: vi.fn(async () => ({ ...input, command: { ...command, agentId: "agent-2" } })),
      claim: vi.fn(async () => null), complete: vi.fn(async () => null), fail: vi.fn(async () => null)
    };
    const executor = { execute: vi.fn() };
    const logger = { log: vi.fn(async () => shutdown.abort()) };
    await new AgentWorker({ agentId: "agent-1", transport, executor, logger }).run(shutdown.signal);
    expect(executor.execute).not.toHaveBeenCalled();
    expect(logger.log).toHaveBeenCalledWith("error", "Transport returned a command assigned to another agent");
  });
});

describe("HttpAgentCommandTransport", () => {
  it("uses fixed same-origin HTTP paths and keeps the token in the authorization header", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
    const transport = new HttpAgentCommandTransport({ apiUrl: "https://api.example.test/base", token: "secret-agent-token", fetch: fetchMock });
    const result = await transport.poll("agent-1", new AbortController().signal);
    expect(result).toBeNull();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://api.example.test/api/v1/agent/commands/next?agentId=agent-1");
    expect(init?.headers).toMatchObject({ authorization: "Bearer secret-agent-token" });
  });

  it("rejects non-HTTP transports", () => {
    expect(() => new HttpAgentCommandTransport({ apiUrl: "file:///tmp/socket", token: "token" })).toThrow("must use HTTP or HTTPS");
  });
});

import { describe, expect, it, vi } from "vitest";
import type { Agent, DeploymentCommand } from "@deploylite/contracts";
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
const snapshot = { cpuLoad: 0.1, memoryUsedBytes: 1, memoryTotalBytes: 2, diskUsedBytes: 3, diskTotalBytes: 4 };
const agent: Agent = { id: "agent-1", name: "Agent", endpoint: "http://agent.test", status: "online", lastHeartbeatAt: "2026-01-01T00:00:00.000Z", resourceSnapshot: snapshot };

function transport(overrides: Partial<AgentCommandTransport> = {}): AgentCommandTransport {
  return {
    register: vi.fn(async () => agent),
    heartbeat: vi.fn(async () => agent),
    poll: vi.fn(async () => null),
    claim: vi.fn(async () => ({ ...command, state: "claimed" as const })),
    complete: vi.fn(async () => ({ ...command, state: "completed" as const })),
    fail: vi.fn(async () => ({ ...command, state: "failed" as const })),
    ...overrides
  };
}

describe("AgentWorker", () => {
  it("polls through the injected transport, executes one command, and stops gracefully", async () => {
    const shutdown = new AbortController();
    const commandTransport = transport({ poll: vi.fn(async () => input) });
    const executor = {
      execute: vi.fn(async () => {
        shutdown.abort();
        return { ok: true, dryRun: false, commands: [] };
      })
    };
    const worker = new AgentWorker({ agentId: "agent-1", agentName: "Agent", agentEndpoint: "http://agent.test", transport: commandTransport, executor, resourceCollector: { collect: async () => snapshot }, retryDelayMs: 0 });

    await worker.run(shutdown.signal);

    expect(commandTransport.register).toHaveBeenCalledOnce();
    expect(commandTransport.poll).toHaveBeenCalledWith("agent-1", shutdown.signal);
    expect(executor.execute).toHaveBeenCalledWith(input);
  });

  it("does not execute a command routed to another agent", async () => {
    const shutdown = new AbortController();
    const commandTransport = transport({ poll: vi.fn(async () => ({ ...input, command: { ...command, agentId: "agent-2" } })) });
    const executor = { execute: vi.fn() };
    const logger = { log: vi.fn(async () => shutdown.abort()) };
    await new AgentWorker({ agentId: "agent-1", agentName: "Agent", agentEndpoint: "http://agent.test", transport: commandTransport, executor, resourceCollector: { collect: async () => snapshot }, logger }).run(shutdown.signal);
    expect(executor.execute).not.toHaveBeenCalled();
    expect(logger.log).toHaveBeenCalledWith("error", "Transport returned a command assigned to another agent");
  });

  it("registers and replays pending terminal acknowledgements before polling", async () => {
    const shutdown = new AbortController();
    const order: string[] = [];
    const commandTransport = transport({
      register: vi.fn(async () => { order.push("register"); return agent; }),
      poll: vi.fn(async () => { order.push("poll"); shutdown.abort(); return null; })
    });
    const terminalAcks = { replayPending: vi.fn(async () => { order.push("replay"); return true; }) };
    await new AgentWorker({
      agentId: "agent-1", agentName: "Agent", agentEndpoint: "http://agent.test", transport: commandTransport,
      executor: { execute: vi.fn() }, resourceCollector: { collect: async () => snapshot }, terminalAcks
    }).run(shutdown.signal);
    expect(order).toEqual(["register", "replay", "poll"]);
  });

  it("does not poll or execute while a terminal acknowledgement remains pending", async () => {
    const shutdown = new AbortController();
    const commandTransport = transport();
    const executor = { execute: vi.fn() };
    const terminalAcks = { replayPending: vi.fn(async () => false) };
    await new AgentWorker({
      agentId: "agent-1", agentName: "Agent", agentEndpoint: "http://agent.test", transport: commandTransport,
      executor, resourceCollector: { collect: async () => snapshot }, terminalAcks,
      wait: async () => { shutdown.abort(); }
    }).run(shutdown.signal);
    expect(commandTransport.poll).not.toHaveBeenCalled();
    expect(executor.execute).not.toHaveBeenCalled();
  });

  it("stops polling and heartbeat loops on shutdown", async () => {
    const shutdown = new AbortController();
    const commandTransport = transport({ poll: vi.fn(async () => { shutdown.abort(); return null; }) });
    await new AgentWorker({
      agentId: "agent-1", agentName: "Agent", agentEndpoint: "http://agent.test", transport: commandTransport,
      executor: { execute: vi.fn() }, resourceCollector: { collect: async () => snapshot }
    }).run(shutdown.signal);
    expect(commandTransport.poll).toHaveBeenCalledOnce();
    expect(commandTransport.heartbeat).not.toHaveBeenCalled();
  });

  it("sends bounded periodic heartbeats from the injectable clock and collector", async () => {
    const shutdown = new AbortController();
    const later = new Date("2026-01-01T00:00:15.000Z");
    const commandTransport = transport({
      heartbeat: vi.fn(async () => { shutdown.abort(); return { ...agent, lastHeartbeatAt: later.toISOString() }; })
    });
    const wait = async (milliseconds: number, signal: AbortSignal) => {
      if (milliseconds === 5_000) return;
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    };
    await new AgentWorker({
      agentId: "agent-1", agentName: "Agent", agentEndpoint: "http://agent.test", transport: commandTransport,
      executor: { execute: vi.fn() }, resourceCollector: { collect: async () => snapshot }, heartbeatIntervalMs: 1,
      now: () => later, wait
    }).run(shutdown.signal);
    expect(commandTransport.heartbeat).toHaveBeenCalledWith("agent-1", later.toISOString(), snapshot, shutdown.signal);
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

  it("registers with an authenticated fixed-origin request", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(agent), { status: 201, headers: { "content-type": "application/json" } }));
    const commandTransport = new HttpAgentCommandTransport({ apiUrl: "https://api.example.test", token: "secret-agent-token", fetch: fetchMock });
    await expect(commandTransport.register({ agentId: "agent-1", name: "Agent", endpoint: "http://agent.test", observedAt: "2026-01-01T00:00:00.000Z", resourceSnapshot: snapshot }, new AbortController().signal)).resolves.toEqual(agent);
    expect(String(fetchMock.mock.calls[0]![0])).toBe("https://api.example.test/api/v1/agent/register");
  });
});

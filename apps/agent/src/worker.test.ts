import { describe, expect, it, vi } from "vitest";
import type { Agent, DeploymentCommand } from "@deploylite/contracts";
import { AgentRequestTimeoutError, AgentWorker, AuthoritativeTerminalConflictError, HttpAgentCommandTransport, type AgentCommandTransport } from "./worker.js";

const command: DeploymentCommand = {
  id: "command-1", deploymentId: "deployment-1", agentId: "agent-1", kind: "start", state: "pending", payload: {}, requestedBy: null,
  requestId: "request-1", correlationId: "correlation-1", issuedAt: "2026-01-01T00:00:00.000Z", claimedAt: null, leaseExpiresAt: null, completedAt: null, failureReason: null
};
const input = {
  command: { ...command, state: "claimed" as const, claimedAt: "2026-01-01T00:00:00.000Z", leaseExpiresAt: "2026-01-01T00:00:30.000Z" },
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
    recoverClaimed: vi.fn(async () => null),
    claim: vi.fn(async () => ({ ...command, state: "claimed" as const, leaseExpiresAt: "2026-01-01T00:00:30.000Z" })),
    renewLease: vi.fn(async () => ({ ...command, state: "claimed" as const, leaseExpiresAt: "2026-01-01T00:00:30.000Z" })),
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
      }),
      reconcile: vi.fn(async () => ({ ok: false, dryRun: false, commands: [] }))
    };
    const worker = new AgentWorker({ agentId: "agent-1", agentName: "Agent", agentEndpoint: "http://agent.test", transport: commandTransport, executor, resourceCollector: { collect: async () => snapshot }, retryDelayMs: 0 });

    await worker.run(shutdown.signal);

    expect(commandTransport.register).toHaveBeenCalledOnce();
    expect(commandTransport.poll).toHaveBeenCalledWith("agent-1", shutdown.signal);
    expect(executor.execute).toHaveBeenCalledWith(input, expect.any(AbortSignal));
  });

  it("does not execute a command routed to another agent", async () => {
    const shutdown = new AbortController();
    const commandTransport = transport({ poll: vi.fn(async () => ({ ...input, command: { ...command, agentId: "agent-2" } })) });
    const executor = { execute: vi.fn(), reconcile: vi.fn() };
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
      executor: { execute: vi.fn(), reconcile: vi.fn() }, resourceCollector: { collect: async () => snapshot }, terminalAcks
    }).run(shutdown.signal);
    expect(order).toEqual(["register", "replay", "poll"]);
  });

  it("writes readiness only after registration and a successful initial poll exchange", async () => {
    const shutdown = new AbortController();
    const readiness = { clear: vi.fn(async () => undefined), markReady: vi.fn(async () => undefined) };
    await new AgentWorker({
      agentId: "agent-1", agentName: "Agent", agentEndpoint: "http://agent.test", transport: transport(),
      executor: { execute: vi.fn(), reconcile: vi.fn() }, resourceCollector: { collect: async () => snapshot }, readiness,
      heartbeatIntervalMs: 60_000,
      wait: async (_milliseconds, signal) => {
        if (readiness.markReady.mock.calls.length > 0) shutdown.abort();
        else await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      }
    }).run(shutdown.signal);
    expect(readiness.markReady).toHaveBeenCalledOnce();
    expect(readiness.clear).toHaveBeenCalledTimes(2);
  });

  it("keeps readiness absent until a transient initial poll failure recovers", async () => {
    const shutdown = new AbortController();
    const readiness = { clear: vi.fn(async () => undefined), markReady: vi.fn(async () => undefined) };
    let waits = 0;
    const commandTransport = transport({ poll: vi.fn(async () => {
      if (readiness.markReady.mock.calls.length === 0 && waits === 0) throw new Error("network unavailable");
      return null;
    }) });
    await new AgentWorker({
      agentId: "agent-1", agentName: "Agent", agentEndpoint: "http://agent.test", transport: commandTransport,
      executor: { execute: vi.fn(), reconcile: vi.fn() }, resourceCollector: { collect: async () => snapshot }, readiness,
      heartbeatIntervalMs: 60_000,
      wait: async (milliseconds, signal) => {
        if (milliseconds !== 1_000) await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
        else { waits += 1; if (waits === 2) shutdown.abort(); }
      }
    }).run(shutdown.signal);
    expect(commandTransport.poll).toHaveBeenCalledTimes(2);
    expect(readiness.markReady).toHaveBeenCalledOnce();
  });

  it("keeps established readiness through a later transient poll failure", async () => {
    const shutdown = new AbortController();
    const events: string[] = [];
    const readiness = { clear: vi.fn(async () => { events.push("clear"); }), markReady: vi.fn(async () => { events.push("ready"); }) };
    let polls = 0;
    let waits = 0;
    const logger = { log: vi.fn() };
    await new AgentWorker({
      agentId: "agent-1", agentName: "Agent", agentEndpoint: "http://agent.test", transport: transport({ poll: vi.fn(async () => {
        polls += 1;
        if (polls === 2) throw new Error("transient network failure");
        return null;
      }) }), executor: { execute: vi.fn(), reconcile: vi.fn() }, resourceCollector: { collect: async () => snapshot }, readiness, logger,
      heartbeatIntervalMs: 60_000,
      wait: async (milliseconds, signal) => {
        if (milliseconds !== 1_000) await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
        else { waits += 1; if (waits === 2) shutdown.abort(); }
      }
    }).run(shutdown.signal);
    expect(events).toEqual(["clear", "ready", "clear"]);
    expect(logger.log).toHaveBeenCalledWith("error", "Agent poll failed: transient network failure");
  });

  it("clears readiness when registration fails before operational exchange", async () => {
    const readiness = { clear: vi.fn(async () => undefined), markReady: vi.fn(async () => undefined) };
    await expect(new AgentWorker({
      agentId: "agent-1", agentName: "Agent", agentEndpoint: "http://agent.test",
      transport: transport({ register: vi.fn(async () => { throw new Error("registration failed"); }) }),
      executor: { execute: vi.fn(), reconcile: vi.fn() }, resourceCollector: { collect: async () => snapshot }, readiness
    }).run(new AbortController().signal)).rejects.toThrow("registration failed");
    expect(readiness.markReady).not.toHaveBeenCalled();
    expect(readiness.clear).toHaveBeenCalledTimes(2);
  });

  it("keeps readiness absent when a stalled poll times out, retries safely, and shuts down without leaking transport details", async () => {
    const shutdown = new AbortController();
    const readiness = { clear: vi.fn(async () => undefined), markReady: vi.fn(async () => undefined) };
    const logger = { log: vi.fn() };
    const now = new Date("2026-01-01T00:00:15.000Z");
    const timeoutDurations: number[] = [];
    const fetchMock = vi.fn<typeof fetch>((request, init) => {
      const url = new URL(String(request));
      if (url.pathname === "/api/v1/agent/register") return Promise.resolve(new Response(JSON.stringify(agent), { status: 201, headers: { "content-type": "application/json" } }));
      if (url.pathname === "/api/v1/agent/commands/claimed") return Promise.resolve(new Response(null, { status: 204 }));
      if (url.pathname === "/api/v1/agent/commands/next") {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("stalled poll aborted", "AbortError")), { once: true });
        });
      }
      throw new Error(`Unexpected request: ${url.pathname}`);
    });
    const commandTransport = new HttpAgentCommandTransport({
      apiUrl: "https://api.example.test",
      token: "secret-agent-token",
      fetch: fetchMock,
      requestTimeoutMs: 1_000,
      setTimeout: (callback, milliseconds) => { timeoutDurations.push(milliseconds); queueMicrotask(callback); return 0 as unknown as ReturnType<typeof setTimeout>; },
      clearTimeout: () => undefined
    });
    const wait = vi.fn(async (milliseconds: number, signal: AbortSignal) => {
      if (milliseconds === 1_000) shutdown.abort();
      else await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    });

    await new AgentWorker({
      agentId: "agent-1", agentName: "Agent", agentEndpoint: "http://agent.test", transport: commandTransport,
      executor: { execute: vi.fn(), reconcile: vi.fn() }, resourceCollector: { collect: async () => snapshot }, readiness, logger,
      now: () => now, wait, heartbeatIntervalMs: 60_000
    }).run(shutdown.signal);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]?.body))).toMatchObject({ observedAt: now.toISOString() });
    expect(timeoutDurations).toContain(1_000);
    expect(fetchMock.mock.calls[2]![1]?.signal?.aborted).toBe(true);
    expect(readiness.markReady).not.toHaveBeenCalled();
    expect(readiness.clear).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledWith(1_000, shutdown.signal);
    expect(logger.log).toHaveBeenCalledWith("error", "Agent poll failed: Agent API request timed out");
    expect(JSON.stringify(logger.log.mock.calls)).not.toContain("secret-agent-token");
    expect(JSON.stringify(logger.log.mock.calls)).not.toContain("stalled poll aborted");
  });

  it("reconciles an owned claimed command after the durable outbox and never executes it again", async () => {
    const shutdown = new AbortController();
    const order: string[] = [];
    const commandTransport = transport({
      register: vi.fn(async () => { order.push("register"); return agent; }),
      recoverClaimed: vi.fn(async () => { order.push("recover"); return input; }),
      poll: vi.fn(async () => { order.push("poll"); shutdown.abort(); return null; })
    });
    const executor = {
      execute: vi.fn(),
      reconcile: vi.fn(async () => { order.push("reconcile"); return { ok: false, dryRun: false, commands: [] }; })
    };
    await new AgentWorker({
      agentId: "agent-1", agentName: "Agent", agentEndpoint: "http://agent.test", transport: commandTransport,
      executor, resourceCollector: { collect: async () => snapshot },
      terminalAcks: { replayPending: vi.fn(async () => { order.push("replay"); return true; }) }
    }).run(shutdown.signal);
    expect(order).toEqual(["register", "replay", "recover", "reconcile", "poll"]);
    expect(executor.execute).not.toHaveBeenCalled();
  });

  it("replays durable managed-resource repairs before command recovery after restart", async () => {
    const shutdown = new AbortController();
    const order: string[] = [];
    const commandTransport = transport({
      recoverClaimed: vi.fn(async () => { order.push("recover"); return null; }),
      poll: vi.fn(async () => { order.push("poll"); shutdown.abort(); return null; })
    });
    const executor = {
      execute: vi.fn(),
      reconcile: vi.fn(),
      reconcilePending: vi.fn(async () => { order.push("repair"); return true; })
    };
    await new AgentWorker({
      agentId: "agent-1", agentName: "Agent", agentEndpoint: "http://agent.test", transport: commandTransport,
      executor, resourceCollector: { collect: async () => snapshot }, terminalAcks: { replayPending: async () => { order.push("outbox"); return true; } }
    }).run(shutdown.signal);
    expect(order).toEqual(["outbox", "repair", "recover", "poll"]);
  });

  it("retries runtime cleanup repairs with bounded backoff while command polling continues", async () => {
    const shutdown = new AbortController();
    let now = 0;
    let polls = 0;
    let activeRepairs = 0;
    let maxActiveRepairs = 0;
    const repairs: string[] = [];
    let recordedRepairAttempts = 0;
    const reconcilePending = vi.fn(async () => {
      activeRepairs += 1;
      maxActiveRepairs = Math.max(maxActiveRepairs, activeRepairs);
      await Promise.resolve();
      activeRepairs -= 1;
      if (repairs.length === 0) return true;
      recordedRepairAttempts += 1;
      if (recordedRepairAttempts === 1) return false;
      repairs.pop();
      return true;
    });
    const commandTransport = transport({ poll: vi.fn(async () => {
      polls += 1;
      if (polls === 1) repairs.push("repair-recorded-after-startup");
      if (polls === 4) shutdown.abort();
      return null;
    }) });
    await new AgentWorker({
      agentId: "agent-1", agentName: "Agent", agentEndpoint: "http://agent.test", transport: commandTransport,
      executor: { execute: vi.fn(), reconcile: vi.fn(), reconcilePending }, resourceCollector: { collect: async () => snapshot },
      retryDelayMs: 10, cleanupRepairIntervalMs: 10, heartbeatIntervalMs: 60_000,
      now: () => new Date(now), wait: async (milliseconds) => { now += milliseconds; }
    }).run(shutdown.signal);
    expect(reconcilePending.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(commandTransport.poll).toHaveBeenCalledTimes(4);
    expect(repairs).toEqual([]);
    expect(maxActiveRepairs).toBe(1);
  });

  it("continues polling when cleanup repair reconciliation throws and stops safely on shutdown", async () => {
    const shutdown = new AbortController();
    const commandTransport = transport({ poll: vi.fn(async () => { await Promise.resolve(); await Promise.resolve(); shutdown.abort(); return null; }) });
    const logger = { log: vi.fn() };
    await new AgentWorker({
      agentId: "agent-1", agentName: "Agent", agentEndpoint: "http://agent.test", transport: commandTransport,
      executor: { execute: vi.fn(), reconcile: vi.fn(), reconcilePending: vi.fn(async () => { throw new Error("secret value"); }) },
      resourceCollector: { collect: async () => snapshot }, logger
    }).run(shutdown.signal);
    expect(commandTransport.poll).toHaveBeenCalledOnce();
    expect(logger.log).toHaveBeenCalledWith("error", "Managed resource cleanup repair reconciliation failed; repair will retry");
  });

  it("keeps polling while a single-flight cleanup repair is stalled and aborts it on shutdown", async () => {
    const shutdown = new AbortController();
    let polls = 0;
    let repairCalls = 0;
    let repairSignal: AbortSignal | undefined;
    const commandTransport = transport({ poll: vi.fn(async () => {
      polls += 1;
      if (polls === 3) shutdown.abort();
      return null;
    }) });
    const reconcilePending = vi.fn(async (signal?: AbortSignal) => {
      repairCalls += 1;
      repairSignal = signal;
      await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
      return false;
    });
    const wait = async (milliseconds: number, signal: AbortSignal) => {
      if (milliseconds === 5_000) await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    };
    await new AgentWorker({
      agentId: "agent-1", agentName: "Agent", agentEndpoint: "http://agent.test", transport: commandTransport,
      executor: { execute: vi.fn(), reconcile: vi.fn(), reconcilePending }, resourceCollector: { collect: async () => snapshot },
      retryDelayMs: 1, heartbeatIntervalMs: 1, cleanupRepairIntervalMs: 1, wait
    }).run(shutdown.signal);
    expect(commandTransport.poll).toHaveBeenCalledTimes(3);
    expect(repairCalls).toBe(1);
    expect(repairSignal?.aborted).toBe(true);
  });

  it("backs off failed cleanup passes without overlapping them", async () => {
    const shutdown = new AbortController();
    const waits: number[] = [];
    let repairCalls = 0;
    const reconcilePending = vi.fn(async () => {
      repairCalls += 1;
      if (repairCalls === 3) shutdown.abort();
      return false;
    });
    await new AgentWorker({
      agentId: "agent-1", agentName: "Agent", agentEndpoint: "http://agent.test", transport: transport(),
      executor: { execute: vi.fn(), reconcile: vi.fn(), reconcilePending }, resourceCollector: { collect: async () => snapshot },
      retryDelayMs: 10, maxHeartbeatBackoffMs: 40, heartbeatIntervalMs: 60_000,
      wait: async (milliseconds) => { waits.push(milliseconds); }
    }).run(shutdown.signal);
    expect(repairCalls).toBe(3);
    expect(waits).toEqual(expect.arrayContaining([10, 20]));
  });

  it("aborts execution when lease renewal cannot be confirmed and does not execute twice", async () => {
    const shutdown = new AbortController();
    const commandTransport = transport({
      poll: vi.fn(async () => input),
      renewLease: vi.fn(async () => { throw new Error("network partition"); })
    });
    const executor = {
      reconcile: vi.fn(),
      execute: vi.fn(async (_input: typeof input, signal?: AbortSignal) => {
        await new Promise<void>((resolve) => signal!.addEventListener("abort", () => resolve(), { once: true }));
        shutdown.abort();
        return { ok: false, dryRun: false, commands: [], reason: "lease lost" };
      })
    };
    await new AgentWorker({
      agentId: "agent-1", agentName: "Agent", agentEndpoint: "http://agent.test", transport: commandTransport,
      executor, resourceCollector: { collect: async () => snapshot }, leaseRenewalIntervalMs: 1,
      wait: async (_milliseconds, signal) => { if (!signal.aborted) await Promise.resolve(); }
    }).run(shutdown.signal);
    expect(commandTransport.renewLease).toHaveBeenCalledOnce();
    expect(executor.execute).toHaveBeenCalledOnce();
  });

  it("does not poll or execute while a terminal acknowledgement remains pending", async () => {
    const shutdown = new AbortController();
    const commandTransport = transport();
    const executor = { execute: vi.fn(), reconcile: vi.fn() };
    const terminalAcks = { replayPending: vi.fn(async () => false) };
    await new AgentWorker({
      agentId: "agent-1", agentName: "Agent", agentEndpoint: "http://agent.test", transport: commandTransport,
      executor, resourceCollector: { collect: async () => snapshot }, terminalAcks,
      wait: async () => { shutdown.abort(); }
    }).run(shutdown.signal);
    expect(commandTransport.poll).not.toHaveBeenCalled();
    expect(executor.execute).not.toHaveBeenCalled();
  });

  it("continues polling after a terminal conflict is authoritatively resolved", async () => {
    const shutdown = new AbortController();
    const commandTransport = transport({ poll: vi.fn(async () => { shutdown.abort(); return null; }) });
    const terminalAcks = { replayPending: vi.fn(async () => true) };
    await new AgentWorker({
      agentId: "agent-1", agentName: "Agent", agentEndpoint: "http://agent.test", transport: commandTransport,
      executor: { execute: vi.fn(), reconcile: vi.fn() }, resourceCollector: { collect: async () => snapshot }, terminalAcks
    }).run(shutdown.signal);
    expect(terminalAcks.replayPending).toHaveBeenCalledOnce();
    expect(commandTransport.poll).toHaveBeenCalledOnce();
  });

  it("stops polling and heartbeat loops on shutdown", async () => {
    const shutdown = new AbortController();
    const commandTransport = transport({ poll: vi.fn(async () => { shutdown.abort(); return null; }) });
    await new AgentWorker({
      agentId: "agent-1", agentName: "Agent", agentEndpoint: "http://agent.test", transport: commandTransport,
      executor: { execute: vi.fn(), reconcile: vi.fn() }, resourceCollector: { collect: async () => snapshot }
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
      if (signal.aborted) return;
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    };
    await new AgentWorker({
      agentId: "agent-1", agentName: "Agent", agentEndpoint: "http://agent.test", transport: commandTransport,
      executor: { execute: vi.fn(), reconcile: vi.fn() }, resourceCollector: { collect: async () => snapshot }, heartbeatIntervalMs: 1,
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

  it("aborts a stalled request and reports a safe timeout error", async () => {
    const fetchMock = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    }));
    const commandTransport = new HttpAgentCommandTransport({
      apiUrl: "https://api.example.test", token: "secret-agent-token", fetch: fetchMock, requestTimeoutMs: 1_000,
      setTimeout: (callback) => { queueMicrotask(callback); return 0 as unknown as ReturnType<typeof setTimeout>; }, clearTimeout: () => undefined
    });
    await expect(commandTransport.register({ agentId: "agent-1", name: "Agent", endpoint: "http://agent.test", observedAt: "2026-01-01T00:00:00.000Z", resourceSnapshot: snapshot }, new AbortController().signal)).rejects.toBeInstanceOf(AgentRequestTimeoutError);
    expect(fetchMock.mock.calls[0]![1]?.signal?.aborted).toBe(true);
  });

  it("parses an authoritative lease conflict so a stale fail outbox can drain", async () => {
    const authoritative = { ...command, state: "failed" as const, leaseExpiresAt: null, completedAt: "2026-01-01T00:00:30.000Z", failureReason: "lease expired" };
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      data: { authoritativeCommand: authoritative, attemptedState: "failed", leaseConflict: true },
      error: { code: "AUTHORITATIVE_LEASE_CONFLICT" }
    }), { status: 409, headers: { "content-type": "application/json" } }));
    const commandTransport = new HttpAgentCommandTransport({ apiUrl: "https://api.example.test", token: "secret-agent-token", fetch: fetchMock });
    const failure = commandTransport.fail(command.id, "stale failure");
    await expect(failure).rejects.toBeInstanceOf(AuthoritativeTerminalConflictError);
    await expect(failure).rejects.toMatchObject({ leaseConflict: true, authoritativeCommand: { state: "failed" } });
  });
});

import { describe, expect, it } from "vitest";
import {
  AgentStatusService,
  InMemoryAgentRepository,
  InMemoryDeploymentCommandRepository,
  InMemoryDeploymentRepository,
  isDeploymentCommandTransitionAllowed
} from "./index.js";

const now = new Date("2026-01-01T00:00:00.000Z");

describe("domain foundation", () => {
  it("marks stale heartbeats without deleting the last resource snapshot", async () => {
    const agents = new InMemoryAgentRepository();
    const service = new AgentStatusService(agents);
    await agents.save({
      id: "agent_1",
      name: "Mock VPS",
      endpoint: "https://agent.example.test",
      status: "online",
      lastHeartbeatAt: "2025-12-31T23:58:00.000Z",
      resourceSnapshot: {
        cpuLoad: 0.2,
        memoryUsedBytes: 10,
        memoryTotalBytes: 100,
        diskUsedBytes: 20,
        diskTotalBytes: 200
      }
    });

    const agent = await agents.findById("agent_1");
    expect(agent ? service.markStale(agent, now).status : "missing").toBe("stale");
  });

  it("uses server receipt time rather than a future observedAt for heartbeat freshness", async () => {
    const agents = new InMemoryAgentRepository();
    const service = new AgentStatusService(agents);
    await agents.save({ id: "agent_1", name: "Agent", endpoint: "https://agent.test", status: "offline", lastHeartbeatAt: null, resourceSnapshot: null });
    await service.recordHeartbeat({
      agentId: "agent_1",
      observedAt: "2099-01-01T00:00:00.000Z",
      resourceSnapshot: { cpuLoad: 0.1, memoryUsedBytes: 1, memoryTotalBytes: 2, diskUsedBytes: 3, diskTotalBytes: 4 },
      requestId: "req_1",
      correlationId: "req_1"
    }, now);
    const stored = await agents.findById("agent_1");
    expect(stored?.lastHeartbeatAt).toBe(now.toISOString());
    expect(stored && service.markStale(stored, new Date(now.getTime() + 60_001)).status).toBe("stale");
  });

  it("updates deployment records when status transitions to a terminal state", async () => {
    const deployments = new InMemoryDeploymentRepository();
    const deployment = {
      id: "dep_1",
      projectId: "project_1",
      agentId: "agent_1",
      status: "running" as const,
      commitSha: "abcdef1",
      startedAt: now.toISOString(),
      finishedAt: null
    };

    await deployments.save(deployment);
    const next = await deployments.save({ ...deployment, status: "succeeded" });
    expect(next.status).toBe("succeeded");
    expect(await deployments.findById("dep_1")).toMatchObject({ status: "succeeded" });
  });

  it("redacts and preserves ordered immutable logs", async () => {
    const deployments = new InMemoryDeploymentRepository();
    await deployments.appendLog({
      id: "log_1",
      deploymentId: "dep_1",
      sequence: 1,
      level: "info",
      message: "deployed with token dl_1234567890abcdef",
      timestamp: now.toISOString(),
      redactionApplied: false,
      requestId: "req_1",
      correlationId: "req_1"
    });

    const logs = await deployments.listLogs("dep_1", 0);
    expect(logs).toHaveLength(1);
    expect(logs[0]?.message).toBe("deployed with token [REDACTED]");
    await expect(deployments.appendLog({ ...logs[0]!, id: "log_2" })).rejects.toThrow("unique");
  });

  it("enforces the deployment command state machine: pending -> claimed -> completed only", () => {
    expect(isDeploymentCommandTransitionAllowed("pending", "claimed")).toBe(true);
    expect(isDeploymentCommandTransitionAllowed("claimed", "completed")).toBe(true);
    expect(isDeploymentCommandTransitionAllowed("pending", "cancelled")).toBe(true);
    expect(isDeploymentCommandTransitionAllowed("claimed", "cancelled")).toBe(true);
    // A pending command may also fail (e.g. validation rejection before
    // any agent claimed it). A claimed command can also fail mid-flight.
    expect(isDeploymentCommandTransitionAllowed("pending", "failed")).toBe(true);
    expect(isDeploymentCommandTransitionAllowed("claimed", "failed")).toBe(true);

    // Terminal states are sinks.
    expect(isDeploymentCommandTransitionAllowed("completed", "claimed")).toBe(false);
    expect(isDeploymentCommandTransitionAllowed("cancelled", "claimed")).toBe(false);
    expect(isDeploymentCommandTransitionAllowed("failed", "claimed")).toBe(false);

    // Skipping claimed for terminal completion is not allowed.
    expect(isDeploymentCommandTransitionAllowed("pending", "completed")).toBe(false);

    // Same-state transitions are always allowed (idempotent retries).
    expect(isDeploymentCommandTransitionAllowed("pending", "pending")).toBe(true);
  });

  it("tracks active deployment commands per deployment in the in-memory repository", async () => {
    const commands = new InMemoryDeploymentCommandRepository();
    const baseCommand = {
      id: "cmd_1",
      deploymentId: "dep_1",
      agentId: "agent_1",
      kind: "start" as const,
      payload: {},
      requestedBy: null,
      requestId: "req_1",
      correlationId: "req_1",
      issuedAt: now.toISOString(),
      claimedAt: null,
      leaseExpiresAt: null,
      completedAt: null,
      failureReason: null
    };

    await commands.save({ ...baseCommand, state: "pending" });
    expect((await commands.findActiveForDeployment("dep_1"))?.state).toBe("pending");
    expect((await commands.findActiveForDeployment("dep_2"))).toBeNull();

    await commands.save({ ...baseCommand, state: "claimed", claimedAt: now.toISOString(), leaseExpiresAt: "2026-01-01T00:00:30.000Z" });
    expect((await commands.findActiveForDeployment("dep_1"))?.state).toBe("claimed");

    await commands.save({ ...baseCommand, state: "completed", completedAt: now.toISOString() });
    expect(await commands.findActiveForDeployment("dep_1")).toBeNull();
  });

  it("allocates unique contiguous log sequences under concurrent writes", async () => {
    const deployments = new InMemoryDeploymentRepository();
    const events = await Promise.all(Array.from({ length: 128 }, (_, index) => deployments.appendAllocatedLog({
      id: `log_${index}`,
      deploymentId: "dep_1",
      level: "info",
      message: `concurrent log ${index}`,
      timestamp: now.toISOString(),
      redactionApplied: false,
      requestId: "req_1",
      correlationId: "req_1"
    })));

    expect(events.map((event) => event.sequence).sort((left, right) => left - right)).toEqual(Array.from({ length: 128 }, (_, index) => index + 1));
  });

  it("allocates after the highest explicitly appended log sequence", async () => {
    const deployments = new InMemoryDeploymentRepository();
    await deployments.appendLog({ id: "explicit_log", deploymentId: "dep_explicit", sequence: 7, level: "info", message: "explicit", timestamp: now.toISOString(), redactionApplied: false, requestId: "req_explicit", correlationId: "corr_explicit" });

    await expect(deployments.appendAllocatedLog({ id: "allocated_log", deploymentId: "dep_explicit", level: "info", message: "allocated", timestamp: now.toISOString(), redactionApplied: false, requestId: "req_explicit", correlationId: "corr_explicit" })).resolves.toMatchObject({ sequence: 8 });
  });

  it("projects a claimed live lease to running with one redacted allocated log and audit event", async () => {
    const deployments = new InMemoryDeploymentRepository();
    const audits: Array<{ action: string; metadata?: Record<string, unknown> }> = [];
    const secretToken = "dl_1234567890abcdef";
    const commands = new InMemoryDeploymentCommandRepository({
      deployments,
      audit: {
        append: async (input) => {
          audits.push(input);
          return { id: "audit_1", actorId: "system", action: input.action, targetType: input.targetType, targetId: input.targetId, requestId: input.requestId, correlationId: input.correlationId, timestamp: now.toISOString() };
        },
        list: async () => ({ events: [], total: 0, limit: 50, offset: 0 })
      },
      now: () => now
    });
    await deployments.save({ id: "dep_running", projectId: "project_1", agentId: "agent_1", status: "queued", commitSha: "abcdef1", startedAt: now.toISOString(), finishedAt: null });
    await commands.save({ id: "cmd_running", deploymentId: "dep_running", agentId: "agent_1", kind: "start", state: "claimed", payload: {}, requestedBy: null, requestId: "req_running", correlationId: "corr_running", issuedAt: now.toISOString(), claimedAt: now.toISOString(), leaseExpiresAt: "2026-01-01T00:00:30.000Z", completedAt: null, failureReason: null });

    const runningProjection = {
      deployment: { id: "dep_running", projectId: "project_1", agentId: "agent_1", status: "running", commitSha: "abcdef1", startedAt: now.toISOString(), finishedAt: null },
      log: { id: "log_running", deploymentId: "dep_running", level: "info", message: `running token ${secretToken}`, timestamp: now.toISOString(), redactionApplied: false, requestId: "req_running", correlationId: "corr_running" },
      audit: { action: "deployment.running", targetType: "deployment", targetId: "dep_running", requestId: "req_running", correlationId: "corr_running", metadata: { token: secretToken } }
    };
    await expect(commands.projectRunning("cmd_running", "agent_1", runningProjection)).resolves.toMatchObject({ applied: true, command: { state: "claimed" } });
    await expect(commands.projectRunning("cmd_running", "agent_1", runningProjection)).resolves.toMatchObject({ applied: true });

    expect(await deployments.findById("dep_running")).toMatchObject({ status: "running" });
    const persistedLogs = await deployments.listLogs("dep_running");
    expect(persistedLogs).toEqual([expect.objectContaining({ sequence: 1, message: "running token [REDACTED]", redactionApplied: true })]);
    expect(JSON.stringify(persistedLogs)).not.toContain(secretToken);
    expect(audits).toEqual([expect.objectContaining({ action: "deployment.running", metadata: { token: "[REDACTED]" } })]);
    expect(JSON.stringify(audits)).not.toContain(secretToken);
  });

  it("rejects equality and expired leases without projecting running state", async () => {
    for (const leaseExpiresAt of [now.toISOString(), "2025-12-31T23:59:59.999Z"]) {
      const deployments = new InMemoryDeploymentRepository();
      const commands = new InMemoryDeploymentCommandRepository({ deployments, audit: { append: async () => { throw new Error("audit must not be appended"); }, list: async () => ({ events: [], total: 0, limit: 50, offset: 0 }) }, now: () => now });
      await deployments.save({ id: `dep_${leaseExpiresAt}`, projectId: "project_1", agentId: "agent_1", status: "queued", commitSha: "abcdef1", startedAt: now.toISOString(), finishedAt: null });
      await commands.save({ id: `cmd_${leaseExpiresAt}`, deploymentId: `dep_${leaseExpiresAt}`, agentId: "agent_1", kind: "start", state: "claimed", payload: {}, requestedBy: null, requestId: "req_lease", correlationId: "corr_lease", issuedAt: now.toISOString(), claimedAt: now.toISOString(), leaseExpiresAt, completedAt: null, failureReason: null });

      await expect(commands.projectRunning(`cmd_${leaseExpiresAt}`, "agent_1", {
        deployment: { id: `dep_${leaseExpiresAt}`, projectId: "project_1", agentId: "agent_1", status: "running", commitSha: "abcdef1", startedAt: now.toISOString(), finishedAt: null },
        log: { id: `log_${leaseExpiresAt}`, deploymentId: `dep_${leaseExpiresAt}`, level: "info", message: "must not persist", timestamp: now.toISOString(), redactionApplied: false, requestId: "req_lease", correlationId: "corr_lease" },
        audit: { action: "deployment.running", targetType: "deployment", targetId: `dep_${leaseExpiresAt}`, requestId: "req_lease", correlationId: "corr_lease" }
      })).resolves.toMatchObject({ applied: false });
      expect(await deployments.findById(`dep_${leaseExpiresAt}`)).toMatchObject({ status: "queued" });
      await expect(deployments.listLogs(`dep_${leaseExpiresAt}`)).resolves.toEqual([]);
    }
  });

  it("leaves deployment, log, and audit untouched when cancellation wins during a running projection", async () => {
    const deployments = new InMemoryDeploymentRepository();
    const audits: string[] = [];
    let releaseProjection: (() => void) | undefined;
    const projectionPaused = new Promise<void>((resolve) => { releaseProjection = resolve; });
    const commands = new InMemoryDeploymentCommandRepository({
      deployments,
      audit: {
        append: async (input) => {
          audits.push(input.action);
          return { id: "audit_cancel", actorId: "system", action: input.action, targetType: input.targetType, targetId: input.targetId, requestId: input.requestId, correlationId: input.correlationId, timestamp: now.toISOString() };
        },
        list: async () => ({ events: [], total: 0, limit: 50, offset: 0 })
      },
      now: () => now,
      beforeProject: () => projectionPaused
    });
    await deployments.save({ id: "dep_cancel", projectId: "project_1", agentId: "agent_1", status: "queued", commitSha: "abcdef1", startedAt: now.toISOString(), finishedAt: null });
    await commands.save({ id: "cmd_cancel", deploymentId: "dep_cancel", agentId: "agent_1", kind: "start", state: "claimed", payload: {}, requestedBy: null, requestId: "req_cancel", correlationId: "corr_cancel", issuedAt: now.toISOString(), claimedAt: now.toISOString(), leaseExpiresAt: "2026-01-01T00:00:30.000Z", completedAt: null, failureReason: null });

    const running = commands.projectRunning("cmd_cancel", "agent_1", {
      deployment: { id: "dep_cancel", projectId: "project_1", agentId: "agent_1", status: "running", commitSha: "abcdef1", startedAt: now.toISOString(), finishedAt: null },
      log: { id: "log_cancel", deploymentId: "dep_cancel", level: "info", message: "must not persist", timestamp: now.toISOString(), redactionApplied: false, requestId: "req_cancel", correlationId: "corr_cancel" },
      audit: { action: "deployment.running", targetType: "deployment", targetId: "dep_cancel", requestId: "req_cancel", correlationId: "corr_cancel" }
    });
    await Promise.resolve();
    await commands.cancel("cmd_cancel", "operator_1", now.toISOString());
    releaseProjection?.();

    await expect(running).resolves.toMatchObject({ applied: false, command: { state: "cancelled" } });
    expect(await deployments.findById("dep_cancel")).toMatchObject({ status: "queued" });
    await expect(deployments.listLogs("dep_cancel")).resolves.toEqual([]);
    expect(audits).toEqual([]);
  });
});

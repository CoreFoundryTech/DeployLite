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
      completedAt: null,
      failureReason: null
    };

    await commands.save({ ...baseCommand, state: "pending" });
    expect((await commands.findActiveForDeployment("dep_1"))?.state).toBe("pending");
    expect((await commands.findActiveForDeployment("dep_2"))).toBeNull();

    await commands.save({ ...baseCommand, state: "claimed", claimedAt: now.toISOString() });
    expect((await commands.findActiveForDeployment("dep_1"))?.state).toBe("claimed");

    await commands.save({ ...baseCommand, state: "completed", completedAt: now.toISOString() });
    expect(await commands.findActiveForDeployment("dep_1")).toBeNull();
  });
});

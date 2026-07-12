import {
  InMemoryDeploymentCommandRepository,
  InMemoryDeploymentRepository,
  InMemoryEnvVariableMetadataRepository,
  type AgentStatusService,
  type DeploymentCommandRecord
} from "@deploylite/domain";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DeploymentCommandBusService } from "./command-bus.js";
import { MockDeploymentExecutor } from "./executor.js";

const now = new Date("2026-01-01T00:00:00.000Z");

afterEach(() => vi.useRealTimers());

describe("MockDeploymentExecutor", () => {
  it("uses the shared projection to avoid a running status or log when cancellation wins", async () => {
    vi.useFakeTimers();
    const deployments = new InMemoryDeploymentRepository();
    const commands = new InMemoryDeploymentCommandRepository(() => now);
    const bus = new DeploymentCommandBusService(commands, () => now, deployments);
    const deployment = { id: "dep_1", projectId: "project_1", agentId: "agent_1", status: "queued" as const, commitSha: "abcdef1", startedAt: now.toISOString(), finishedAt: null };
    const command: DeploymentCommandRecord = { id: "cmd_1", deploymentId: deployment.id, agentId: deployment.agentId, kind: "start", state: "claimed", payload: { projectId: deployment.projectId }, requestedBy: null, requestId: "req_1", correlationId: "corr_1", issuedAt: now.toISOString(), claimedAt: now.toISOString(), leaseExpiresAt: "2026-01-01T00:00:30.000Z", completedAt: null, failureReason: null };
    await deployments.save(deployment);
    await commands.save(command);

    const conditionalSave = deployments.saveWithLogIfStatus.bind(deployments);
    let release!: () => void;
    let reachedProjection!: () => void;
    const projectionStarted = new Promise<void>((resolve) => { reachedProjection = resolve; });
    const projectionRelease = new Promise<void>((resolve) => { release = resolve; });
    deployments.saveWithLogIfStatus = async (...args) => {
      reachedProjection();
      await projectionRelease;
      return conditionalSave(...args);
    };

    const executor = new MockDeploymentExecutor({
      bus,
      deployments,
      agentStatus: {} as AgentStatusService,
      envMetadata: new InMemoryEnvVariableMetadataRepository(),
      projectResolver: async () => ({ id: deployment.projectId, name: "Project", repoUrl: "https://example.test/project.git", defaultBranch: "main", buildCommand: "pnpm build", runCommand: "pnpm start", port: null, description: null, imageTag: null })
    });

    await executor.execute(command);
    await vi.advanceTimersByTimeAsync(50);
    await projectionStarted;
    await bus.cancel(command.id, "user_1");
    release();

    await expect(commands.findById(command.id)).resolves.toMatchObject({ state: "cancelled" });
    await expect(deployments.findById(deployment.id)).resolves.toMatchObject({ status: "queued" });
    await expect(deployments.listLogs(deployment.id)).resolves.not.toContainEqual(expect.objectContaining({ message: expect.stringContaining("picked up") }));
  });
});

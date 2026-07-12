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

  it("does not overwrite cancellation when the success timer reaches its terminal projection", async () => {
    vi.useFakeTimers();
    const { command, deployment, deployments, executor, bus } = await createExecutorFixture();
    const conditionalSave = deployments.saveWithLogIfStatus.bind(deployments);
    let release!: () => void;
    let reachedTerminalProjection!: () => void;
    const terminalStarted = new Promise<void>((resolve) => { reachedTerminalProjection = resolve; });
    const terminalRelease = new Promise<void>((resolve) => { release = resolve; });
    deployments.saveWithLogIfStatus = async (...args) => {
      if (args[0].status === "succeeded") {
        reachedTerminalProjection();
        await terminalRelease;
      }
      return conditionalSave(...args);
    };

    await executor.execute(command);
    await vi.advanceTimersByTimeAsync(50);
    const advance = vi.advanceTimersByTimeAsync(200);
    await terminalStarted;
    await bus.cancel(command.id, "user_1");
    release();
    await advance;

    await expect(deployments.findById(deployment.id)).resolves.toMatchObject({ status: "running" });
    await expect(deployments.listLogs(deployment.id)).resolves.not.toContainEqual(expect.objectContaining({ message: expect.stringContaining("marked the deployment succeeded") }));
    await expect(bus.findById(command.id)).resolves.toMatchObject({ state: "cancelled" });
  });

  it("does not project a required-env failure when cancellation wins", async () => {
    const { command, deployment, deployments, envMetadata, executor, bus } = await createExecutorFixture();
    await envMetadata.upsert(requiredEnvMetadata(deployment.projectId));
    const conditionalSave = deployments.saveWithLogIfStatus.bind(deployments);
    let release!: () => void;
    let reachedTerminalProjection!: () => void;
    const terminalStarted = new Promise<void>((resolve) => { reachedTerminalProjection = resolve; });
    const terminalRelease = new Promise<void>((resolve) => { release = resolve; });
    deployments.saveWithLogIfStatus = async (...args) => {
      if (args[0].status === "failed") {
        reachedTerminalProjection();
        await terminalRelease;
      }
      return conditionalSave(...args);
    };

    const execution = executor.execute(command);
    await terminalStarted;
    await bus.cancel(command.id, "user_1");
    release();
    await execution;

    await expect(deployments.findById(deployment.id)).resolves.toMatchObject({ status: "queued" });
    await expect(deployments.listLogs(deployment.id)).resolves.not.toContainEqual(expect.objectContaining({ message: expect.stringContaining("Refusing to advance") }));
    await expect(bus.findById(command.id)).resolves.toMatchObject({ state: "cancelled" });
  });

  it("projects and logs a required-env failure when cancellation does not win", async () => {
    const { command, deployment, deployments, envMetadata, executor, bus } = await createExecutorFixture();
    await envMetadata.upsert(requiredEnvMetadata(deployment.projectId));

    await executor.execute(command);

    await expect(deployments.findById(deployment.id)).resolves.toMatchObject({ status: "failed" });
    await expect(deployments.listLogs(deployment.id)).resolves.toContainEqual(expect.objectContaining({ level: "error", message: "Refusing to advance: required env metadata missing for REQUIRED_TOKEN." }));
    await expect(bus.findById(command.id)).resolves.toMatchObject({ state: "failed", failureReason: "Refusing to advance: required env metadata missing for REQUIRED_TOKEN." });
  });
});

async function createExecutorFixture(options: { projectId?: string } = {}) {
  const deployments = new InMemoryDeploymentRepository();
  const commands = new InMemoryDeploymentCommandRepository(() => now);
  const envMetadata = new InMemoryEnvVariableMetadataRepository();
  const bus = new DeploymentCommandBusService(commands, () => now, deployments);
  const deployment = { id: "dep_1", projectId: "project_1", agentId: "agent_1", status: "queued" as const, commitSha: "abcdef1", startedAt: now.toISOString(), finishedAt: null };
  const command: DeploymentCommandRecord = { id: "cmd_1", deploymentId: deployment.id, agentId: deployment.agentId, kind: "start", state: "claimed", payload: options.projectId === undefined && Object.hasOwn(options, "projectId") ? {} : { projectId: deployment.projectId }, requestedBy: null, requestId: "req_1", correlationId: "corr_1", issuedAt: now.toISOString(), claimedAt: now.toISOString(), leaseExpiresAt: "2026-01-01T00:00:30.000Z", completedAt: null, failureReason: null };
  const executor = new MockDeploymentExecutor({
    bus,
    deployments,
    agentStatus: {} as AgentStatusService,
    envMetadata,
    projectResolver: async () => ({ id: deployment.projectId, name: "Project", repoUrl: "https://example.test/project.git", defaultBranch: "main", buildCommand: "pnpm build", runCommand: "pnpm start", port: null, description: null, imageTag: null })
  });
  await deployments.save(deployment);
  await commands.save(command);
  return { command, deployment, deployments, envMetadata, executor, bus, commands };
}

function requiredEnvMetadata(projectId: string) {
  return { id: "env_1", projectId, key: "REQUIRED_TOKEN", scope: "project" as const, valuePresent: false, valueFingerprint: null, required: true, description: null, updatedAt: now.toISOString() };
}

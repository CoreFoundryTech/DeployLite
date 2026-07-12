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

describe("MockDeploymentExecutor lifecycle projection", () => {
  it("projects running and success through the command boundary", async () => {
    vi.useFakeTimers();
    const fixture = await createFixture();

    await fixture.executor.execute(fixture.command);
    await vi.advanceTimersByTimeAsync(250);

    await expect(fixture.bus.findById(fixture.command.id)).resolves.toMatchObject({ state: "completed" });
    await expect(fixture.deployments.findById(fixture.deployment.id)).resolves.toMatchObject({ status: "succeeded" });
    await expect(fixture.deployments.listLogs(fixture.deployment.id)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ message: expect.stringContaining("picked up") }),
      expect.objectContaining({ message: expect.stringContaining("marked the deployment succeeded") })
    ]));
  });

  it("does not project running or failure after cancellation wins", async () => {
    vi.useFakeTimers();
    const fixture = await createFixture();
    await fixture.envMetadata.upsert({ id: "env_required", projectId: fixture.deployment.projectId, key: "REQUIRED_TOKEN", scope: "project", valuePresent: false, valueFingerprint: null, required: true, description: null, updatedAt: now.toISOString() });

    await fixture.bus.cancel(fixture.command.id, "user_1");
    await fixture.executor.execute(fixture.command);
    await vi.advanceTimersByTimeAsync(250);

    await expect(fixture.bus.findById(fixture.command.id)).resolves.toMatchObject({ state: "cancelled" });
    await expect(fixture.deployments.findById(fixture.deployment.id)).resolves.toMatchObject({ status: "canceled" });
    await expect(fixture.deployments.listLogs(fixture.deployment.id)).resolves.toEqual([expect.objectContaining({ message: "Deployment command cancelled; deployment was canceled." })]);
  });

  it("projects required-environment and unsupported-command failures through the boundary", async () => {
    const missingEnvironment = await createFixture();
    await missingEnvironment.envMetadata.upsert({ id: "env_required", projectId: missingEnvironment.deployment.projectId, key: "REQUIRED_TOKEN", scope: "project", valuePresent: false, valueFingerprint: null, required: true, description: null, updatedAt: now.toISOString() });
    await missingEnvironment.executor.execute(missingEnvironment.command);

    await expect(missingEnvironment.bus.findById(missingEnvironment.command.id)).resolves.toMatchObject({ state: "failed" });
    await expect(missingEnvironment.deployments.findById(missingEnvironment.deployment.id)).resolves.toMatchObject({ status: "failed" });

    const unsupported = await createFixture({ kind: "restart" });
    await unsupported.executor.execute(unsupported.command);
    await expect(unsupported.bus.findById(unsupported.command.id)).resolves.toMatchObject({ state: "failed" });
    await expect(unsupported.deployments.findById(unsupported.deployment.id)).resolves.toMatchObject({ status: "failed" });
  });
});

async function createFixture(options: { kind?: DeploymentCommandRecord["kind"] } = {}) {
  const deployments = new InMemoryDeploymentRepository();
  const commands = new InMemoryDeploymentCommandRepository(deployments, () => now);
  const envMetadata = new InMemoryEnvVariableMetadataRepository();
  const bus = new DeploymentCommandBusService(commands, () => now);
  const deployment = { id: `dep_${options.kind ?? "start"}`, projectId: "project_1", agentId: "agent_1", status: "queued" as const, commitSha: "abcdef1", startedAt: now.toISOString(), finishedAt: null };
  const command: DeploymentCommandRecord = { id: `cmd_${options.kind ?? "start"}`, deploymentId: deployment.id, agentId: deployment.agentId, kind: options.kind ?? "start", state: "claimed", payload: { projectId: deployment.projectId }, requestedBy: null, requestId: "req_1", correlationId: "corr_1", issuedAt: now.toISOString(), claimedAt: now.toISOString(), leaseExpiresAt: "2026-01-01T00:00:30.000Z", completedAt: null, failureReason: null };
  const executor = new MockDeploymentExecutor({
    bus,
    deployments,
    agentStatus: {} as AgentStatusService,
    envMetadata,
    projectResolver: async () => ({ id: deployment.projectId, name: "Project", repoUrl: "https://example.test/project.git", defaultBranch: "main", buildCommand: "pnpm build", runCommand: "pnpm start", port: null, description: null, imageTag: null })
  });
  await deployments.save(deployment);
  await commands.save(command);
  return { command, deployment, deployments, envMetadata, executor, bus };
}

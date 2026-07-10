import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { DeploymentCommand } from "@deploylite/contracts";
import { AgentDeploymentExecutor, createDeploymentPlan, type CommandBusClient, type HealthProbe, type ProcessRunner, type WorkspaceFilesystem } from "./index.js";

const command: DeploymentCommand = {
  id: "command-1", deploymentId: "deployment-1", agentId: "agent-1", kind: "start", state: "pending", payload: {}, requestedBy: null,
  requestId: "request-1", correlationId: "correlation-1", issuedAt: "2026-01-01T00:00:00.000Z", claimedAt: null, completedAt: null, failureReason: null
};
const input = { command, repoUrl: "https://github.com/acme/service.git", ref: "main", projectSlug: "service", workspaceRoot: "/safe/workspaces", healthUrl: "http://service:3000/health" };

function setup(results = [{ code: 0, stdout: "", stderr: "", timedOut: false }]) {
  const runner: ProcessRunner = { run: vi.fn(async () => results.shift() ?? { code: 0, stdout: "", stderr: "", timedOut: false }) };
  const bus: CommandBusClient = { claim: vi.fn(async () => ({ ...command, state: "claimed" as const })), complete: vi.fn(async () => null), fail: vi.fn(async () => null) };
  const health: HealthProbe = { probe: vi.fn(async () => true) };
  const filesystem: WorkspaceFilesystem = { create: vi.fn(async () => undefined), remove: vi.fn(async () => undefined) };
  return { runner, bus, health, filesystem, executor: new AgentDeploymentExecutor(runner, bus, health, { log: vi.fn() }, async () => undefined, filesystem) };
}

describe("AgentDeploymentExecutor", () => {
  it("claims, executes the argv-only git/build/compose plan, probes health, then completes", async () => {
    const test = setup();
    const result = await test.executor.execute(input);
    expect(result.ok).toBe(true);
    expect(test.runner.run).toHaveBeenCalledTimes(5);
    expect(test.runner.run).toHaveBeenNthCalledWith(1, expect.objectContaining({ command: "git", args: expect.arrayContaining(["clone", "--no-checkout"]) }), expect.any(Number));
    expect(test.runner.run).toHaveBeenNthCalledWith(4, expect.objectContaining({ command: "docker", args: expect.arrayContaining(["build", "--tag", "deploylite/service:command-1"]) }), expect.any(Number));
    expect(test.bus.complete).toHaveBeenCalledWith("command-1", expect.objectContaining({ imageTag: "deploylite/service:command-1" }));
    expect(test.filesystem.create).toHaveBeenCalled();
  });

  it("records a redacted command failure and safely cleans up a partial compose deployment", async () => {
    const test = setup([{ code: 0, stdout: "", stderr: "", timedOut: false }, { code: 0, stdout: "", stderr: "", timedOut: false }, { code: 0, stdout: "", stderr: "", timedOut: false }, { code: 0, stdout: "", stderr: "", timedOut: false }, { code: 1, stdout: "token=super-secret", stderr: "failed", timedOut: false }]);
    const result = await test.executor.execute(input);
    expect(result.ok).toBe(false);
    expect(result.reason).not.toContain("super-secret");
    expect(test.runner.run).toHaveBeenCalledWith(expect.objectContaining({ args: expect.arrayContaining(["down", "--remove-orphans"]) }), expect.any(Number));
    expect(test.filesystem.remove).toHaveBeenCalled();
    expect(test.bus.fail).toHaveBeenCalledWith("command-1", expect.not.stringContaining("super-secret"));
  });

  it("fails a bounded health probe and cleans up without running shell interpolation", async () => {
    const test = setup();
    test.health.probe = vi.fn(async () => false);
    const result = await test.executor.execute(input);
    expect(result.reason).toBe("Health probe timed out");
    expect(test.health.probe).toHaveBeenCalledTimes(5);
    expect(test.bus.fail).toHaveBeenCalledWith("command-1", "Health probe timed out");
  });

  it("fails an expired process timeout without attempting a shell command", async () => {
    const test = setup([{ code: 1, stdout: "", stderr: "", timedOut: true }]);
    const result = await test.executor.execute(input);
    expect(result.reason).toBe("Timed out: git");
    expect(test.runner.run).toHaveBeenCalledWith(expect.objectContaining({ command: "git" }), expect.any(Number));
    expect(test.filesystem.remove).toHaveBeenCalled();
  });

  it("returns a dry-run plan without runner or filesystem side effects", async () => {
    const test = setup();
    const result = await test.executor.execute({ ...input, dryRun: true });
    expect(result).toMatchObject({ ok: true, dryRun: true });
    expect(test.runner.run).not.toHaveBeenCalled();
    expect(test.filesystem.create).not.toHaveBeenCalled();
    expect(test.bus.claim).toHaveBeenCalledWith("command-1", "agent-1");
    expect(test.bus.complete).toHaveBeenCalledWith("command-1", expect.objectContaining({ dryRun: true }));
  });

  it("rejects unsafe repository, ref, and workspace input before a command is invoked", () => {
    expect(() => createDeploymentPlan({ ...input, repoUrl: "https://example.com/repo;rm -rf /" })).toThrow("Invalid repository URL");
    expect(() => createDeploymentPlan({ ...input, ref: "--upload-pack=evil" })).toThrow("Invalid git ref");
    expect(() => createDeploymentPlan({ ...input, workspaceRoot: "/safe/workspaces", command: { ...command, id: "../escape" } })).toThrow("Invalid project slug or command id");
  });
});

describe("agent-only Docker socket compose boundary", () => {
  it("mounts the Docker socket only on the agent service", async () => {
    const compose = await readFile(resolve(import.meta.dirname, "../../../../infra/vps/compose.yml"), "utf8");
    const socket = "/var/run/docker.sock:/var/run/docker.sock";
    expect(compose).toMatch(/agent:[\s\S]*volumes:[\s\S]*\/var\/run\/docker\.sock:\/var\/run\/docker\.sock/);
    for (const service of ["api", "web", "migrate", "postgres"]) {
      const block = compose.match(new RegExp(`  ${service}:([\\s\\S]*?)(?=\\n  [a-z][a-z-]*:|\\nvolumes:)`))?.[1] ?? "";
      expect(block).not.toContain(socket);
    }
  });
});

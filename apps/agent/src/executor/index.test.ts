import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { DeploymentCommand } from "@deploylite/contracts";
import { AgentDeploymentExecutor, createDeploymentPlan, createSpawnProcessRunner, type CommandBusClient, type HealthProbe, type ProcessRunner, type SpawnedProcess, type WorkspaceFilesystem } from "./index.js";

const command: DeploymentCommand = {
  id: "command-1", deploymentId: "deployment-1", agentId: "agent-1", kind: "start", state: "pending", payload: {}, requestedBy: null,
  requestId: "request-1", correlationId: "correlation-1", issuedAt: "2026-01-01T00:00:00.000Z", claimedAt: null, completedAt: null, failureReason: null
};
const executorConfig = { workspaceRoot: "/var/lib/deploylite/workspaces" };
const input = { command, repoUrl: "https://github.com/acme/service.git", ref: "main", projectSlug: "service", healthUrl: "http://service:3000/health", envFile: { contents: "TOKEN=super-secret" } };

function setup(results = [{ code: 0, stdout: "", stderr: "", timedOut: false }]) {
  const runner: ProcessRunner = { run: vi.fn(async () => results.shift() ?? { code: 0, stdout: "", stderr: "", timedOut: false }) };
  const bus: CommandBusClient = { claim: vi.fn(async () => ({ ...command, state: "claimed" as const })), complete: vi.fn(async () => null), fail: vi.fn(async () => null) };
  const health: HealthProbe = { probe: vi.fn(async () => true) };
  const filesystem: WorkspaceFilesystem = { create: vi.fn(async () => undefined), remove: vi.fn(async () => undefined), writeSecretFile: vi.fn(async () => undefined), removeSecretFile: vi.fn(async () => undefined) };
  return { runner, bus, health, filesystem, executor: new AgentDeploymentExecutor(runner, bus, health, { log: vi.fn() }, async () => undefined, filesystem, executorConfig) };
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
    expect(test.filesystem.writeSecretFile).toHaveBeenCalledWith(expect.stringMatching(/\.env$/), "TOKEN=super-secret");
    expect(test.filesystem.removeSecretFile).toHaveBeenCalledWith(expect.stringMatching(/\.env$/));
  });

  it("records a redacted command failure and safely cleans up a partial compose deployment", async () => {
    const test = setup([{ code: 0, stdout: "", stderr: "", timedOut: false }, { code: 0, stdout: "", stderr: "", timedOut: false }, { code: 0, stdout: "", stderr: "", timedOut: false }, { code: 0, stdout: "", stderr: "", timedOut: false }, { code: 1, stdout: "token=super-secret", stderr: "failed", timedOut: false }]);
    const result = await test.executor.execute(input);
    expect(result.ok).toBe(false);
    expect(result.reason).not.toContain("super-secret");
    expect(test.runner.run).toHaveBeenCalledWith(expect.objectContaining({ args: expect.arrayContaining(["down", "--remove-orphans"]) }), expect.any(Number));
    expect(test.filesystem.remove).toHaveBeenCalled();
    expect(test.filesystem.removeSecretFile).toHaveBeenCalledWith(expect.stringMatching(/\.env$/));
    expect(test.bus.fail).toHaveBeenCalledWith("command-1", expect.not.stringContaining("super-secret"));
  });

  it("removes an env file when writing succeeds but chmod fails", async () => {
    const test = setup();
    let writtenEnvFile: string | undefined;
    test.filesystem.writeSecretFile = vi.fn(async (path) => {
      writtenEnvFile = path;
      throw new Error("chmod failed");
    });

    const result = await test.executor.execute(input);

    expect(result.reason).toBe("chmod failed");
    expect(writtenEnvFile).toMatch(/\.env$/);
    expect(test.filesystem.removeSecretFile).toHaveBeenCalledWith(writtenEnvFile);
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
    expect(() => createDeploymentPlan({ ...input, repoUrl: "https://example.com/repo;rm -rf /" }, executorConfig)).toThrow("Invalid repository URL");
    expect(() => createDeploymentPlan({ ...input, repoUrl: "https://user:secret@example.com/repo.git" }, executorConfig)).toThrow("Invalid repository URL");
    expect(() => createDeploymentPlan({ ...input, ref: "--upload-pack=evil" }, executorConfig)).toThrow("Invalid git ref");
    expect(() => createDeploymentPlan({ ...input, command: { ...command, id: "../escape" } }, executorConfig)).toThrow("Invalid project slug or command id");
    expect(() => createDeploymentPlan(input, { workspaceRoot: "/tmp/workspaces" })).toThrow("outside the allowed agent work base");
    expect(() => createDeploymentPlan(input, { workspaceRoot: "/var/lib/deploylite/workspaces/../../escape" })).toThrow("outside the allowed agent work base");
    expect(() => createDeploymentPlan({ ...input, envFile: undefined as never }, executorConfig)).toThrow("secret env-file is required");
  });

  it("redacts credential-bearing URLs returned by a runner before failures are logged", async () => {
    const test = setup([{ code: 1, stdout: "", stderr: "clone failed https://user:secret@example.com/repo.git", timedOut: false }]);
    const result = await test.executor.execute(input);
    expect(result.reason).not.toContain("user:secret");
    expect(test.bus.fail).toHaveBeenCalledWith("command-1", expect.not.stringContaining("user:secret"));
  });
});

describe("spawnProcessRunner", () => {
  it("escalates an ignored SIGTERM to SIGKILL and rejects without waiting for close", async () => {
    vi.useFakeTimers();
    const child = new EventEmitter() as EventEmitter & SpawnedProcess;
    child.stdout = new EventEmitter() as SpawnedProcess["stdout"];
    child.stderr = new EventEmitter() as SpawnedProcess["stderr"];
    child.kill = vi.fn(() => true);
    const runner = createSpawnProcessRunner(() => child, 25);
    const result = runner.run({ command: "ignored", args: [] }, 10);
    const rejection = expect(result).rejects.toThrow("Command timed out after 10ms");
    await vi.advanceTimersByTimeAsync(35);
    await rejection;
    expect(child.kill).toHaveBeenNthCalledWith(1, "SIGTERM");
    expect(child.kill).toHaveBeenNthCalledWith(2, "SIGKILL");
    child.emit("close", 0);
    vi.useRealTimers();
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

  it("installs the executor runtime tools in the minimal pinned Alpine image", async () => {
    const dockerfile = await readFile(resolve(import.meta.dirname, "../../Dockerfile"), "utf8");
    expect(dockerfile).toContain("node:22.14.0-alpine3.21");
    expect(dockerfile).toContain("apk add --no-cache git docker-cli docker-cli-compose");
  });

  it("guards the configured workspace root against symlink escapes before filesystem writes", async () => {
    const executor = await readFile(resolve(import.meta.dirname, "index.ts"), "utf8");
    expect(executor).toContain("assertTrustedWorkspaceRoot(root)");
    expect(executor).toContain("await realpath(dirname(path))");
    expect(executor).toContain("Deployment workspace may not be a symbolic link");
    expect(executor).toContain("Deployment workspace escaped its trusted root");
  });
});

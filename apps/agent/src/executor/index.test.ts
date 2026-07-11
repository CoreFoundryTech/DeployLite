import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { DeploymentCommand } from "@deploylite/contracts";
import { AgentDeploymentExecutor, assertSafeRuntimePlan, createDeploymentPlan, createSpawnProcessRunner, type CleanupRepairStore, type CommandBusClient, type HealthProbe, type ProcessRunner, type SpawnedProcess, type WorkspaceFilesystem } from "./index.js";
import { InMemoryCleanupRepairStore } from "../cleanup-repairs.js";
import { InMemoryManagedBuilderRegistry } from "../managed-builders.js";

const command: DeploymentCommand = {
  id: "command-1", deploymentId: "deployment-1", agentId: "agent-1", kind: "start", state: "pending", payload: {}, requestedBy: null,
  requestId: "request-1", correlationId: "correlation-1", issuedAt: "2026-01-01T00:00:00.000Z", claimedAt: null, leaseExpiresAt: null, completedAt: null, failureReason: null
};
const executorConfig = { workspaceRoot: "/var/lib/deploylite/workspaces", secretRoot: "/run/deploylite/secrets" };
const input = { command, repoUrl: "https://github.com/acme/service.git", ref: "main", projectSlug: "service", healthUrl: "http://deploylite-command-1:3000/health", envFile: { contents: "TOKEN=super-secret" } };

function setup(results = [{ code: 0, stdout: "", stderr: "", timedOut: false }]) {
  const runner: ProcessRunner = { run: vi.fn(async (plan) => {
    const result = results.shift() ?? { code: 0, stdout: "", stderr: "", timedOut: false };
    if (plan.args.includes("{{json .HostConfig}}") && result.code === 0 && !result.stdout) {
      return { ...result, stdout: JSON.stringify({ Memory: 1073741824, MemorySwap: 1073741824, CpuPeriod: 100000, CpuQuota: 100000, PidsLimit: 256, NetworkMode: "deploylite-build-command-1", Privileged: false }) };
    }
    return result;
  }) };
  const fail = vi.fn(async () => null);
  const bus: CommandBusClient = { claim: vi.fn(async () => ({ ...command, state: "claimed" as const, leaseExpiresAt: "2026-01-01T00:00:30.000Z" })), renewLease: vi.fn(async () => null), complete: vi.fn(async () => null), fail };
  const health: HealthProbe = { probe: vi.fn(async () => true) };
  const filesystem: WorkspaceFilesystem = {
    create: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
    createSecretDirectory: vi.fn(async () => undefined),
    removeSecretDirectory: vi.fn(async () => undefined),
    writeSecretFile: vi.fn(async () => undefined),
    removeSecretFile: vi.fn(async () => undefined)
  };
  const logger = { log: vi.fn() };
  const cleanupRepairs = new InMemoryCleanupRepairStore();
  return { runner, bus, fail, health, filesystem, logger, cleanupRepairs, executor: new AgentDeploymentExecutor(runner, bus, health, logger, async () => undefined, filesystem, executorConfig, cleanupRepairs) };
}

describe("AgentDeploymentExecutor", () => {
  it("builds before creating an external env file, starts a controlled runtime, then completes", async () => {
    const test = setup();
    const result = await test.executor.execute(input);
    expect(result.ok).toBe(true);
    expect(test.runner.run).toHaveBeenCalledTimes(18);
    expect(test.runner.run).toHaveBeenNthCalledWith(1, expect.objectContaining({ command: "git", args: expect.arrayContaining(["clone", "--no-checkout"]) }), expect.any(Number));
    expect(test.runner.run).toHaveBeenNthCalledWith(9, expect.objectContaining({ command: "docker", args: expect.arrayContaining(["buildx", "build", "--builder", "deploylite-command-1", "--network", "none", "--output", "type=docker,name=deploylite/service:command-1"]) }), expect.any(Number));
    expect(test.runner.run).toHaveBeenNthCalledWith(10, expect.objectContaining({ command: "docker", args: expect.arrayContaining(["run", "--read-only", "--env-file"]) }), expect.any(Number));
    expect(test.bus.complete).toHaveBeenCalledWith("command-1", expect.objectContaining({ imageTag: "deploylite/service:command-1" }));
    expect(test.filesystem.create).toHaveBeenCalled();
    expect(test.filesystem.writeSecretFile).toHaveBeenCalledWith("/run/deploylite/secrets/command-1/runtime.env", "TOKEN=super-secret");
    expect(test.filesystem.removeSecretFile).toHaveBeenCalledWith("/run/deploylite/secrets/command-1/runtime.env");
    expect(vi.mocked(test.runner.run).mock.invocationCallOrder[3]).toBeLessThan(vi.mocked(test.filesystem.writeSecretFile).mock.invocationCallOrder[0]!);
  });

  it("does not fail or clean a healthy runtime when completion acknowledgement delivery fails", async () => {
    const test = setup();
    test.bus.complete = vi.fn(async () => { throw new Error("completion ACK lost"); });

    await expect(test.executor.execute(input)).rejects.toThrow("completion ACK lost");

    expect(test.bus.fail).not.toHaveBeenCalled();
    expect(test.runner.run).not.toHaveBeenCalledWith(expect.objectContaining({ args: ["rm", "--force", expect.any(String)] }), expect.any(Number));
  });

  it("records a redacted command failure and cleans only DeployLite-labelled runtime resources", async () => {
    const test = setup();
    vi.mocked(test.runner.run).mockImplementation(async (plan) => {
      if (plan.args.includes("{{json .HostConfig}}")) return boundedBuilderResult();
      if (plan.args[0] === "run") return { code: 1, stdout: "token=super-secret", stderr: "failed", timedOut: false };
      return { code: 0, stdout: "", stderr: "", timedOut: false };
    });
    const result = await test.executor.execute(input);
    expect(result.ok).toBe(false);
    expect(result.reason).not.toContain("super-secret");
    expect(test.runner.run).toHaveBeenCalledWith(expect.objectContaining({ args: expect.arrayContaining(["ps", "--all", "--filter", "label=com.deploylite.managed=true", "--filter", "label=com.deploylite.command-id=command-1"]) }), expect.any(Number));
    expect(test.runner.run).toHaveBeenCalledWith(expect.objectContaining({ args: expect.arrayContaining(["image", "ls", "--filter", "reference=deploylite/service:command-1", "--filter", "label=com.deploylite.managed=true"]) }), expect.any(Number));
    expect(test.filesystem.remove).toHaveBeenCalled();
    expect(test.filesystem.removeSecretFile).toHaveBeenCalledWith(expect.stringMatching(/\.env$/));
    expect(test.bus.fail).toHaveBeenCalledWith("command-1", expect.not.stringContaining("super-secret"));
  });

  it("removes the exact partial env file when chmod fails after its secret write", async () => {
    const test = setup();
    const partialSecretFiles = new Map<string, string>();
    test.filesystem.writeSecretFile = vi.fn(async (path, contents) => {
      partialSecretFiles.set(path, contents);
      throw new Error("chmod failed");
    });

    const result = await test.executor.execute(input);
    const [partialEnvPath] = [...partialSecretFiles.keys()];

    expect(result.reason).toBe("chmod failed");
    expect(partialEnvPath).toBe("/run/deploylite/secrets/command-1/runtime.env");
    expect(partialSecretFiles.get(partialEnvPath!)).toBe(input.envFile.contents);
    expect(test.filesystem.removeSecretFile).toHaveBeenCalledWith(partialEnvPath);
    expect(JSON.stringify([result, test.fail.mock.calls, test.logger.log.mock.calls])).not.toContain(input.envFile.contents);
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

  it("aborts on lease loss, cleans managed resources, and terminally fails", async () => {
    const test = setup();
    const controller = new AbortController();
    vi.mocked(test.runner.run).mockImplementation(async (_plan, _timeout, signal) => {
      controller.abort();
      if (signal?.aborted) throw new Error("Deployment execution lease was lost");
      return { code: 0, stdout: "", stderr: "", timedOut: false };
    });
    const result = await test.executor.execute({ ...input, command: { ...input.command, state: "claimed", leaseExpiresAt: "2026-01-01T00:00:30.000Z" } }, controller.signal);
    expect(result).toMatchObject({ ok: false, reason: "Deployment execution lease was lost" });
    expect(test.filesystem.remove).toHaveBeenCalled();
    expect(test.bus.fail).toHaveBeenCalledWith("command-1", "Deployment execution lease was lost");
  });

  it("performs explicit trusted Docker cleanup after a build timeout", async () => {
    const test = setup();
    vi.mocked(test.runner.run).mockImplementation(async (plan) => {
      if (plan.args.includes("{{json .HostConfig}}")) return boundedBuilderResult();
      if (plan.args[0] === "buildx" && plan.args[1] === "build") return { code: 1, stdout: "", stderr: "", timedOut: true };
      return { code: 0, stdout: "", stderr: "", timedOut: false };
    });
    const result = await test.executor.execute(input);
    expect(result.reason).toBe("Timed out: docker");
    expect(test.runner.run).toHaveBeenCalledWith(expect.objectContaining({ args: expect.arrayContaining(["ps", "--all", "--filter", "name=^/deploylite-command-1$"]) }), 60_000);
    expect(test.runner.run).toHaveBeenCalledWith(expect.objectContaining({ args: expect.arrayContaining(["image", "ls", "--filter", "reference=deploylite/service:command-1"]) }), 60_000);
  });

  it("preserves the primary error and reaches commandBus.fail when every cleanup fails", async () => {
    const test = setup([
      { code: 0, stdout: "", stderr: "", timedOut: false },
      { code: 0, stdout: "", stderr: "", timedOut: false },
      { code: 0, stdout: "", stderr: "", timedOut: false },
      { code: 0, stdout: "", stderr: "", timedOut: false },
      { code: 1, stdout: "", stderr: "primary runtime failure", timedOut: false }
    ]);
    test.filesystem.removeSecretFile = vi.fn(async () => { throw new Error("secret cleanup TOKEN=leak"); });
    test.filesystem.removeSecretDirectory = vi.fn(async () => { throw new Error("directory cleanup"); });
    test.filesystem.remove = vi.fn(async () => { throw new Error("workspace cleanup"); });
    vi.mocked(test.runner.run).mockImplementation(async (plan) => {
      if (plan.args[0] === "rm" || plan.args[0] === "image") throw new Error("docker cleanup");
      return resultsForPrimaryFailure(plan);
    });
    const result = await test.executor.execute(input);
    expect(result.reason).toContain("primary runtime failure");
    expect(test.fail).toHaveBeenCalledWith("command-1", expect.stringContaining("primary runtime failure"));
    expect(JSON.stringify(test.logger.log.mock.calls)).not.toContain("TOKEN=leak");
  });

  it("redacts multiline secret continuations from result, logger, and commandBus.fail", async () => {
    const pemBody = "MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYw-private-body";
    const test = setup([{ code: 1, stdout: `PRIVATE_KEY=-----BEGIN PRIVATE KEY-----\n${pemBody}\n-----END PRIVATE KEY-----`, stderr: "", timedOut: false }]);
    const result = await test.executor.execute(input);
    const exposed = JSON.stringify([result, test.logger.log.mock.calls, test.fail.mock.calls]);
    expect(exposed).not.toContain(pemBody);
    expect(exposed).not.toContain("BEGIN PRIVATE KEY");
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
    expect(() => createDeploymentPlan(input, { ...executorConfig, workspaceRoot: "/tmp/workspaces" })).toThrow("outside the allowed agent work base");
    expect(() => createDeploymentPlan(input, { ...executorConfig, workspaceRoot: "/var/lib/deploylite/workspaces/../../escape" })).toThrow("outside the allowed agent work base");
    expect(() => createDeploymentPlan({ ...input, envFile: undefined as never }, executorConfig)).toThrow("secret env-file is required");
    expect(() => createDeploymentPlan({ ...input, healthUrl: "http://127.0.0.1:3000/" }, executorConfig)).toThrow("managed runtime container");
    expect(() => createDeploymentPlan({ ...input, healthUrl: "http://deploylite-command-1:70000/" }, executorConfig)).toThrow("Invalid health URL");
  });

  it("generates a resource-bounded runtime plan outside the repository context and rejects unsafe flags", () => {
    const plan = createDeploymentPlan(input, executorConfig).at(-1)!;
    expect(assertSafeRuntimePlan(plan)).toBe(true);
    expect(plan.cwd).toBeUndefined();
    expect(plan.args).toContain("/run/deploylite/secrets/command-1/runtime.env");
    expect(plan.args).toEqual(expect.arrayContaining(["--network", "deploylite-runtime", "--name", "deploylite-command-1"]));
    expect(input.healthUrl).toBe("http://deploylite-command-1:3000/health");
    expect(plan.args.join(" ")).not.toMatch(/compose|--privileged|docker\.sock|--volume|-v |--publish|-p |--network=host|--pid |--ipc |--device |--cap-add/);
    for (const unsafeOption of ["--privileged", "--network=host", "--pid=host", "--ipc=host", "--device=/dev/sda", "--cap-add=SYS_ADMIN", "--volume=/host:/data", "--mount=type=bind,src=/,dst=/host"]) {
      expect(() => assertSafeRuntimePlan({ ...plan, args: [...plan.args.slice(0, -1), unsafeOption, plan.args.at(-1)!] })).toThrow(unsafeOption.startsWith("--network") ? "trusted DeployLite network" : "Unsafe Docker runtime option rejected");
    }
    expect(() => assertSafeRuntimePlan({ ...plan, args: [...plan.args.slice(0, -1), "--network", "attacker-network", plan.args.at(-1)!] })).toThrow("trusted DeployLite network");
    expect(() => assertSafeRuntimePlan({ ...plan, args: plan.args.map((arg) => arg === "no-new-privileges" ? "seccomp=unconfined" : arg) })).toThrow("weakens container isolation");
  });

  it("uses only the exact DeployLite-controlled bounded BuildKit builder policy", () => {
    const plans = createDeploymentPlan({ ...input, command: { ...command, payload: { builder: "attacker", network: "host", output: "/tmp/escape" } } }, executorConfig);
    expect(plans[3]).toEqual({ command: "docker", args: ["network", "create", "--driver", "bridge", "--label", "com.deploylite.managed=true", "--label", "com.deploylite.command-id=command-1", "--label", "com.deploylite.project-slug=service", "deploylite-build-command-1"] });
    expect(plans[4]).toEqual({
      command: "docker",
      args: ["buildx", "create", "--name", "deploylite-command-1", "--driver", "docker-container", "--driver-opt", "network=deploylite-build-command-1,memory=1g,memory-swap=1g,cpu-period=100000,cpu-quota=100000,restart-policy=no", "--buildkitd-config", "/etc/deploylite/buildkitd.toml"]
    });
    expect(plans[6]?.args).toEqual(["update", "--pids-limit", "256", "buildx_buildkit_deploylite-command-10"]);
    expect(plans[8]?.args).toEqual(["buildx", "build", "--builder", "deploylite-command-1", "--network", "none", "--progress", "plain", "--label", "com.deploylite.managed=true", "--label", "com.deploylite.command-id=command-1", "--label", "com.deploylite.project-slug=service", "--output", "type=docker,name=deploylite/service:command-1", "/var/lib/deploylite/workspaces/command-1"]);
    expect(plans.some((plan) => plan.args[0] === "build")).toBe(false);
    expect(JSON.stringify(plans)).not.toMatch(/attacker|network=host|\/tmp\/escape|--privileged|--mount|--device|--cap-add/);
  });

  it("fails closed before build when the bounded builder cannot be proven", async () => {
    const test = setup();
    vi.mocked(test.runner.run).mockImplementation(async (plan) => plan.args.includes("{{json .HostConfig}}")
      ? { ...boundedBuilderResult(), stdout: JSON.stringify({ Memory: 1073741824, MemorySwap: 1073741824, CpuPeriod: 100000, CpuQuota: 100000, PidsLimit: 0, NetworkMode: "deploylite-build-command-1", Privileged: false }) }
      : { code: 0, stdout: "", stderr: "", timedOut: false });
    const result = await test.executor.execute(input);
    expect(result.reason).toBe("Bounded BuildKit builder is unavailable");
    expect(test.runner.run).not.toHaveBeenCalledWith(expect.objectContaining({ args: expect.arrayContaining(["buildx", "build"]) }), expect.any(Number));
  });

  it("rechecks absent resources, removes late labelled container and image IDs, and preserves unrelated IDs", async () => {
    const test = setup();
    let containerChecks = 0;
    let imageChecks = 0;
    vi.mocked(test.runner.run).mockImplementation(async (plan) => {
      if (plan.args.includes("{{json .HostConfig}}")) return boundedBuilderResult();
      if (plan.args[0] === "run") return { code: 1, stdout: "", stderr: "runtime failed", timedOut: false };
      if (plan.args[0] === "ps") return { code: 0, stdout: ++containerChecks === 2 ? "a".repeat(64) : "", stderr: "", timedOut: false };
      if (plan.args[0] === "image") return { code: 0, stdout: ++imageChecks === 2 ? "b".repeat(64) : "", stderr: "", timedOut: false };
      return { code: 0, stdout: "", stderr: "", timedOut: false };
    });
    await test.executor.execute(input);
    expect(test.runner.run).toHaveBeenCalledWith({ command: "docker", args: ["rm", "--force", "a".repeat(64)] }, 60_000);
    expect(test.runner.run).toHaveBeenCalledWith({ command: "docker", args: ["image", "rm", "--force", "b".repeat(64)] }, 60_000);
    expect(JSON.stringify(vi.mocked(test.runner.run).mock.calls)).not.toContain("c".repeat(64));
    expect(await test.cleanupRepairs.load()).toEqual([]);
  });

  it("bounds cleanup exhaustion, retains repair state, and clears it on restart without another terminal effect", async () => {
    const test = setup();
    vi.mocked(test.runner.run).mockImplementation(async (plan) => {
      if (plan.args.includes("{{json .HostConfig}}")) return boundedBuilderResult();
      if (plan.args[0] === "run") return { code: 1, stdout: "", stderr: "runtime failed", timedOut: false };
      if (plan.args[0] === "ps" || plan.args[0] === "image" || (plan.args[0] === "buildx" && plan.args[1] === "ls") || (plan.args[0] === "network" && plan.args[1] === "ls")) throw new Error("daemon unavailable");
      return { code: 0, stdout: "", stderr: "", timedOut: false };
    });
    const result = await test.executor.execute(input);
    expect(result.reason).toContain("cleanup incomplete");
    expect(vi.mocked(test.runner.run).mock.calls.filter(([plan]) => plan.args[0] === "ps")).toHaveLength(4);
    expect(await test.cleanupRepairs.load()).toEqual([{ version: 1, commandId: "command-1", projectSlug: "service" }]);
    const terminalCalls = test.fail.mock.calls.length;
    const repairRunner: ProcessRunner = { run: vi.fn(async () => ({ code: 0, stdout: "", stderr: "", timedOut: false })) };
    const restarted = new AgentDeploymentExecutor(repairRunner, test.bus, test.health, test.logger, async () => undefined, test.filesystem, executorConfig, test.cleanupRepairs);
    await expect(restarted.reconcilePending()).resolves.toBe(true);
    expect(await test.cleanupRepairs.load()).toEqual([]);
    expect(test.fail).toHaveBeenCalledTimes(terminalCalls);
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

  it("terminates the POSIX process group when the command times out", async () => {
    vi.useFakeTimers();
    const child = new EventEmitter() as EventEmitter & SpawnedProcess;
    child.pid = 4321;
    child.stdout = new EventEmitter() as SpawnedProcess["stdout"];
    child.stderr = new EventEmitter() as SpawnedProcess["stderr"];
    child.kill = vi.fn(() => true);
    const killGroup = vi.fn();
    const runner = createSpawnProcessRunner(() => child, 5, killGroup);
    const rejection = expect(runner.run({ command: "ignored", args: [] }, 10)).rejects.toThrow("Command timed out after 10ms");
    await vi.advanceTimersByTimeAsync(15);
    await rejection;
    if (process.platform === "win32") expect(child.kill).toHaveBeenCalled();
    else expect(killGroup.mock.calls).toEqual([[-4321, "SIGTERM"], [-4321, "SIGKILL"]]);
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

  it("isolates control-plane services from runtimes and makes the agent the only bridge", async () => {
    const compose = await readFile(resolve(import.meta.dirname, "../../../../infra/vps/compose.yml"), "utf8");
    const memberships = Object.fromEntries(
      ["postgres", "migrate", "api", "agent", "web"].map((service) => [service, composeServiceNetworks(compose, service)])
    );

    expect(memberships).toEqual({
      postgres: ["control-plane"],
      migrate: ["control-plane"],
      api: ["control-plane"],
      agent: ["control-plane", "runtime"],
      web: ["control-plane"]
    });
    expect(compose).toMatch(/networks:\s*\n  control-plane:\s*\n    name: deploylite-control-plane\s*\n    driver: bridge\s*\n  runtime:\s*\n    name: deploylite-runtime\s*\n    driver: bridge/);
  });

  it("wires stable agent identity and a durable agent-only acknowledgement volume without embedding a token", async () => {
    const compose = await readFile(resolve(import.meta.dirname, "../../../../infra/vps/compose.yml"), "utf8");
    const agentBlock = compose.match(/  agent:([\s\S]*?)(?=\n  web:)/)?.[1] ?? "";
    expect(agentBlock).toContain("DEPLOYLITE_AGENT_NAME:");
    expect(agentBlock).toContain("DEPLOYLITE_AGENT_ENDPOINT:");
    expect(agentBlock).toContain("DEPLOYLITE_AGENT_TOKEN: ${DEPLOYLITE_AGENT_TOKEN:?");
    expect(agentBlock).toContain("agent-state:/var/lib/deploylite/state");
    for (const service of ["postgres", "migrate", "api", "web"]) {
      const block = compose.match(new RegExp(`  ${service}:([\\s\\S]*?)(?=\\n  [a-z][a-z-]*:|\\nvolumes:)`))?.[1] ?? "";
      expect(block).not.toContain("agent-state:/var/lib/deploylite/state");
    }
    expect(compose).not.toMatch(/DEPLOYLITE_AGENT_TOKEN:\s+[A-Za-z0-9]{32,}/);
  });

  it("installs the executor runtime tools in the minimal pinned Alpine image", async () => {
    const dockerfile = await readFile(resolve(import.meta.dirname, "../../Dockerfile"), "utf8");
    expect(dockerfile).toContain("node:22.14.0-alpine3.21");
    expect(dockerfile).toContain("apk add --no-cache git docker-cli docker-cli-buildx docker-cli-compose");
    expect(dockerfile).toContain("COPY apps/agent/buildkitd.toml /etc/deploylite/buildkitd.toml");
    expect(dockerfile).toContain('CMD ["node", "apps/agent/dist/main.js"]');
    for (const runtimePath of ["apps/agent/node_modules", "packages/config/dist", "packages/config/node_modules", "packages/contracts/dist", "packages/contracts/node_modules", "packages/domain/dist", "packages/domain/node_modules"]) {
      expect(dockerfile).toContain(runtimePath);
    }
    const require = createRequire(import.meta.url);
    expect(require.resolve("@deploylite/config")).toMatch(/packages\/config\/dist\/index\.js$/);
    expect(require.resolve("@deploylite/contracts")).toMatch(/packages\/contracts\/dist\/index\.js$/);
    expect(require.resolve("@deploylite/domain")).toMatch(/packages\/domain\/dist\/index\.js$/);
    expect(require.resolve("zod")).toMatch(/node_modules\/.pnpm\/zod@/);
  });

  it("guards the configured workspace root against symlink escapes before filesystem writes", async () => {
    const executor = await readFile(resolve(import.meta.dirname, "index.ts"), "utf8");
    expect(executor).toContain("assertTrustedWorkspaceRoot(root)");
    expect(executor).toContain("await realpath(dirname(path))");
    expect(executor).toContain("Deployment workspace may not be a symbolic link");
    expect(executor).toContain("Deployment workspace escaped its trusted root");
  });

  it("documents bounded BuildKit policy and residual socket risk without claiming a complete sandbox", async () => {
    const [readme, infra] = await Promise.all([
      readFile(resolve(import.meta.dirname, "../../../../README.md"), "utf8"),
      readFile(resolve(import.meta.dirname, "../../../../infra/README.md"), "utf8")
    ]);
    for (const document of [readme, infra]) {
      expect(document).toContain("Buildx");
      expect(document).toContain("fails closed");
      expect(document).toContain("host-root-equivalent");
      expect(document).toMatch(/BuildKit.*risk|Residual risk/s);
    }
  });

  it("reconstructs only exact labelled DeployLite resources after a quarantined store reset", async () => {
    let recoveryPending = true;
    const recovered: unknown[][] = [];
    const cleanupRepairs: CleanupRepairStore = {
      load: vi.fn(async () => []), put: vi.fn(async () => undefined), remove: vi.fn(async () => undefined),
      recoveryRequired: vi.fn(async () => recoveryPending),
      completeRecovery: vi.fn(async (records) => { recovered.push(records); recoveryPending = false; })
    };
    const test = setup();
    const runner: ProcessRunner = { run: vi.fn(async (plan) => {
      if (plan.args[0] === "ps") return { code: 0, stdout: "deploylite-command-1\ttrue\tcommand-1\tservice\nforeign\ttrue\tcommand-1\tservice\n", stderr: "", timedOut: false };
      if (plan.args[0] === "image") return { code: 0, stdout: "deploylite/service\tcommand-1\ttrue\tcommand-1\tservice\ndeploylite/service\twrong\ttrue\tcommand-1\tservice\n", stderr: "", timedOut: false };
      if (plan.args[0] === "network") return { code: 0, stdout: "deploylite-build-command-1\ttrue\tcommand-1\tservice\n", stderr: "", timedOut: false };
      return { code: 0, stdout: "deploylite-command-1\nattacker-builder\n", stderr: "", timedOut: false };
    }) };
    const executor = new AgentDeploymentExecutor(runner, test.bus, test.health, test.logger, async () => undefined, test.filesystem, executorConfig, cleanupRepairs);

    await expect(executor.reconcilePending()).resolves.toBe(true);

    expect(recovered).toEqual([[{ version: 1, commandId: "command-1", projectSlug: "service" }]]);
    expect(vi.mocked(runner.run).mock.calls.every(([plan]) => !["rm", "image", "network"].includes(plan.args[1] ?? ""))).toBe(true);
  });

  it("retains the recovery marker when trusted discovery fails", async () => {
    const completeRecovery = vi.fn(async () => undefined);
    const cleanupRepairs: CleanupRepairStore = {
      load: vi.fn(async () => []), put: vi.fn(async () => undefined), remove: vi.fn(async () => undefined),
      recoveryRequired: vi.fn(async () => true), completeRecovery
    };
    const test = setup();
    const runner: ProcessRunner = { run: vi.fn(async () => { throw new Error("discovery unavailable"); }) };
    const executor = new AgentDeploymentExecutor(runner, test.bus, test.health, test.logger, async () => undefined, test.filesystem, executorConfig, cleanupRepairs);

    await expect(executor.reconcilePending()).resolves.toBe(false);
    expect(completeRecovery).not.toHaveBeenCalled();
  });

  it.each([0, 1, 16, 17, 255, 256])("persists all %i discovered repair records in bounded durable pages", async (count) => {
    const records = new Map<string, { version: 1; commandId: string; projectSlug: string }>();
    let pending = true;
    let cursor = 0;
    const store: CleanupRepairStore = {
      load: vi.fn(async () => [...records.values()]), put: vi.fn(async (record) => { records.set(record.commandId, record); }), remove: vi.fn(async () => undefined),
      recoveryRequired: vi.fn(async () => pending), recoveryProgress: vi.fn(async () => ({ cursor })),
      persistRecoveryPage: vi.fn(async (page, next) => { for (const record of page) records.set(record.commandId, record); cursor = next; }),
      completeRecovery: vi.fn(async () => { pending = false; })
    };
    const test = setup();
    const lines = Array.from({ length: count }, (_, index) => `deploylite-command-${index}\ttrue\tcommand-${index}\tservice`).join("\n");
    const runner: ProcessRunner = { run: vi.fn(async (plan) => ({ code: 0, stdout: plan.args[0] === "ps" ? lines : "", stderr: "", timedOut: false })) };
    const executor = new AgentDeploymentExecutor(runner, test.bus, test.health, test.logger, async () => undefined, test.filesystem, executorConfig, store);
    for (let attempt = 0; attempt < 20 && pending; attempt += 1) await executor.reconcilePending();
    expect(pending).toBe(false);
    expect(records.size).toBe(count);
    expect(cursor).toBe(count);
  });

  it("fails closed at 257 discoveries and never clears the recovery marker", async () => {
    let pending = true; let overflowReason: string | undefined;
    const store: CleanupRepairStore = {
      load: vi.fn(async () => []), put: vi.fn(async () => undefined), remove: vi.fn(async () => undefined), recoveryRequired: vi.fn(async () => pending),
      recoveryProgress: vi.fn(async () => ({ cursor: 0, overflowReason })),
      persistRecoveryPage: vi.fn(async (_page, _cursor, reason) => { overflowReason = reason; }), completeRecovery: vi.fn(async () => { pending = false; })
    };
    const test = setup();
    const lines = Array.from({ length: 257 }, (_, index) => `deploylite-command-${index}\ttrue\tcommand-${index}\tservice`).join("\n");
    const runner: ProcessRunner = { run: vi.fn(async (plan) => ({ code: 0, stdout: plan.args[0] === "ps" ? lines : "", stderr: "", timedOut: false })) };
    const executor = new AgentDeploymentExecutor(runner, test.bus, test.health, test.logger, async () => undefined, test.filesystem, executorConfig, store);
    await expect(executor.reconcilePending()).resolves.toBe(false);
    expect(pending).toBe(true); expect(overflowReason).toContain("256-record");
  });

  it("ignores a similarly named builder unless it is in the durable managed registry", async () => {
    const test = setup();
    const registry = new InMemoryManagedBuilderRegistry();
    const runner: ProcessRunner = { run: vi.fn(async (plan) => ({ code: 0, stdout: plan.args[0] === "buildx" ? "deploylite-command-1" : "", stderr: "", timedOut: false })) };
    const executor = new AgentDeploymentExecutor(runner, test.bus, test.health, test.logger, async () => undefined, test.filesystem, executorConfig, test.cleanupRepairs, registry);
    await executor.reconcile({ ...input, command: { ...command, state: "claimed" } });
    expect(vi.mocked(runner.run).mock.calls.some(([plan]) => plan.args.includes("buildx") && plan.args.includes("rm"))).toBe(false);
  });

  it("recovers a builder-only orphan only from the managed registry", async () => {
    const test = setup();
    const registry = new InMemoryManagedBuilderRegistry();
    await registry.put({ version: 1, commandId: "command-1", builderName: "deploylite-command-1" });
    let listed = true;
    const runner: ProcessRunner = { run: vi.fn(async (plan) => {
      if (plan.args[0] === "buildx" && plan.args[1] === "ls") return { code: 0, stdout: listed ? "deploylite-command-1" : "", stderr: "", timedOut: false };
      if (plan.args[0] === "buildx" && plan.args[1] === "rm") { listed = false; return { code: 0, stdout: "", stderr: "", timedOut: false }; }
      return { code: 0, stdout: "", stderr: "", timedOut: false };
    }) };
    const executor = new AgentDeploymentExecutor(runner, test.bus, test.health, test.logger, async () => undefined, test.filesystem, executorConfig, test.cleanupRepairs, registry);
    await executor.reconcile({ ...input, command: { ...command, state: "claimed" } });
    expect(vi.mocked(runner.run)).toHaveBeenCalledWith(expect.objectContaining({ args: ["buildx", "rm", "--force", "deploylite-command-1"] }), expect.any(Number));
    expect(await registry.load()).toEqual([]);
  });
});

function composeServiceNetworks(compose: string, service: string): string[] {
  const serviceBlock = compose.match(new RegExp(`^  ${service}:\\n([\\s\\S]*?)(?=^  [a-z][a-z-]*:|^volumes:|^networks:)`, "m"))?.[1];
  if (!serviceBlock) throw new Error(`Compose service not found: ${service}`);
  const networkBlock = serviceBlock.match(/^    networks:\n((?:^      - [a-z][a-z-]*\n?)+)/m)?.[1];
  if (!networkBlock) throw new Error(`Compose networks not found: ${service}`);
  return [...networkBlock.matchAll(/^      - ([a-z][a-z-]*)$/gm)].map((match) => match[1]!);
}

function resultsForPrimaryFailure(plan: { command: string; args: string[] }) {
  if (plan.args.includes("{{json .HostConfig}}")) return Promise.resolve(boundedBuilderResult());
  if (plan.command === "docker" && plan.args[0] === "run") {
    return Promise.resolve({ code: 1, stdout: "", stderr: "primary runtime failure", timedOut: false });
  }
  return Promise.resolve({ code: 0, stdout: "", stderr: "", timedOut: false });
}

function boundedBuilderResult() {
  return {
    code: 0,
    stdout: JSON.stringify({ Memory: 1073741824, MemorySwap: 1073741824, CpuPeriod: 100000, CpuQuota: 100000, PidsLimit: 256, NetworkMode: "deploylite-build-command-1", Privileged: false }),
    stderr: "",
    timedOut: false
  };
}

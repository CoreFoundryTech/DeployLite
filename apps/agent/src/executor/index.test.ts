import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { DeploymentCommand } from "@deploylite/contracts";
import { AgentDeploymentExecutor, assertSafeRuntimePlan, createDeploymentPlan, createSpawnProcessRunner, type CommandBusClient, type HealthProbe, type ProcessRunner, type SpawnedProcess, type WorkspaceFilesystem } from "./index.js";

const command: DeploymentCommand = {
  id: "command-1", deploymentId: "deployment-1", agentId: "agent-1", kind: "start", state: "pending", payload: {}, requestedBy: null,
  requestId: "request-1", correlationId: "correlation-1", issuedAt: "2026-01-01T00:00:00.000Z", claimedAt: null, leaseExpiresAt: null, completedAt: null, failureReason: null
};
const executorConfig = { workspaceRoot: "/var/lib/deploylite/workspaces", secretRoot: "/run/deploylite/secrets" };
const input = { command, repoUrl: "https://github.com/acme/service.git", ref: "main", projectSlug: "service", healthUrl: "http://deploylite-command-1:3000/health", envFile: { contents: "TOKEN=super-secret" } };

function setup(results = [{ code: 0, stdout: "", stderr: "", timedOut: false }]) {
  const runner: ProcessRunner = { run: vi.fn(async () => results.shift() ?? { code: 0, stdout: "", stderr: "", timedOut: false }) };
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
  return { runner, bus, fail, health, filesystem, logger, executor: new AgentDeploymentExecutor(runner, bus, health, logger, async () => undefined, filesystem, executorConfig) };
}

describe("AgentDeploymentExecutor", () => {
  it("builds before creating an external env file, starts a controlled runtime, then completes", async () => {
    const test = setup();
    const result = await test.executor.execute(input);
    expect(result.ok).toBe(true);
    expect(test.runner.run).toHaveBeenCalledTimes(5);
    expect(test.runner.run).toHaveBeenNthCalledWith(1, expect.objectContaining({ command: "git", args: expect.arrayContaining(["clone", "--no-checkout"]) }), expect.any(Number));
    expect(test.runner.run).toHaveBeenNthCalledWith(4, expect.objectContaining({ command: "docker", args: expect.arrayContaining(["build", "--tag", "deploylite/service:command-1"]) }), expect.any(Number));
    expect(test.runner.run).toHaveBeenNthCalledWith(5, expect.objectContaining({ command: "docker", args: expect.arrayContaining(["run", "--read-only", "--env-file"]) }), expect.any(Number));
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
    expect(test.runner.run).not.toHaveBeenCalledWith(expect.objectContaining({ args: ["rm", "--force", "deploylite-command-1"] }), expect.any(Number));
    expect(test.runner.run).not.toHaveBeenCalledWith(expect.objectContaining({ args: ["image", "rm", "--force", "deploylite/service:command-1"] }), expect.any(Number));
  });

  it("records a redacted command failure and cleans only DeployLite-labelled runtime resources", async () => {
    const test = setup([{ code: 0, stdout: "", stderr: "", timedOut: false }, { code: 0, stdout: "", stderr: "", timedOut: false }, { code: 0, stdout: "", stderr: "", timedOut: false }, { code: 0, stdout: "", stderr: "", timedOut: false }, { code: 1, stdout: "token=super-secret", stderr: "failed", timedOut: false }]);
    const result = await test.executor.execute(input);
    expect(result.ok).toBe(false);
    expect(result.reason).not.toContain("super-secret");
    expect(test.runner.run).toHaveBeenCalledWith(expect.objectContaining({ args: ["rm", "--force", "deploylite-command-1"] }), expect.any(Number));
    expect(test.runner.run).toHaveBeenCalledWith(expect.objectContaining({ args: ["image", "rm", "--force", "deploylite/service:command-1"] }), expect.any(Number));
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
    const test = setup([
      { code: 0, stdout: "", stderr: "", timedOut: false },
      { code: 0, stdout: "", stderr: "", timedOut: false },
      { code: 0, stdout: "", stderr: "", timedOut: false },
      { code: 1, stdout: "", stderr: "", timedOut: true }
    ]);
    const result = await test.executor.execute(input);
    expect(result.reason).toBe("Timed out: docker");
    expect(test.runner.run).toHaveBeenCalledWith(expect.objectContaining({ args: ["rm", "--force", "deploylite-command-1"] }), 60_000);
    expect(test.runner.run).toHaveBeenCalledWith(expect.objectContaining({ args: ["image", "rm", "--force", "deploylite/service:command-1"] }), 60_000);
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
    expect(dockerfile).toContain("apk add --no-cache git docker-cli docker-cli-compose");
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
});

function composeServiceNetworks(compose: string, service: string): string[] {
  const serviceBlock = compose.match(new RegExp(`^  ${service}:\\n([\\s\\S]*?)(?=^  [a-z][a-z-]*:|^volumes:|^networks:)`, "m"))?.[1];
  if (!serviceBlock) throw new Error(`Compose service not found: ${service}`);
  const networkBlock = serviceBlock.match(/^    networks:\n((?:^      - [a-z][a-z-]*\n?)+)/m)?.[1];
  if (!networkBlock) throw new Error(`Compose networks not found: ${service}`);
  return [...networkBlock.matchAll(/^      - ([a-z][a-z-]*)$/gm)].map((match) => match[1]!);
}

function resultsForPrimaryFailure(plan: { command: string; args: string[] }) {
  if (plan.command === "docker" && plan.args[0] === "run") {
    return Promise.resolve({ code: 1, stdout: "", stderr: "primary runtime failure", timedOut: false });
  }
  return Promise.resolve({ code: 0, stdout: "", stderr: "", timedOut: false });
}

import { chmod, lstat, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, relative, resolve } from "node:path";
import { redactSecrets } from "@deploylite/config";
import type { DeploymentCommand } from "@deploylite/contracts";

const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_TIMEOUT_MS = 10 * 60 * 1000;
const TERMINATION_GRACE_MS = 5_000;
const AGENT_WORK_BASE = "/var/lib/deploylite";
const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const SAFE_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const SAFE_REPOSITORY = /^(https:\/\/[^\s]+|git@[A-Za-z0-9._-]+:[A-Za-z0-9._/-]+\.git)$/;

export type CommandPlan = { command: string; args: string[]; cwd?: string };
export type ProcessResult = { code: number; stdout: string; stderr: string; timedOut: boolean };
export type ProcessRunner = { run(plan: CommandPlan, timeoutMs: number): Promise<ProcessResult> };
// Structural subset of the Phase 5 command-bus port. Keeping this local avoids
// an agent -> API dependency while remaining compatible with the shared bus.
export type CommandBusClient = {
  claim(commandId: string, agentId: string): Promise<DeploymentCommand | null>;
  complete(commandId: string, output?: Record<string, unknown>): Promise<DeploymentCommand | null>;
  fail(commandId: string, reason: string): Promise<DeploymentCommand | null>;
};
export type HealthProbe = { probe(url: string, timeoutMs: number): Promise<boolean> };
export type ExecutorLogger = { log(level: "info" | "error", message: string): Promise<void> | void };
export type WorkspaceFilesystem = {
  create(path: string): Promise<void>;
  remove(path: string): Promise<void>;
  writeSecretFile(path: string, contents: string): Promise<void>;
  removeSecretFile(path: string): Promise<void>;
};

export type ExecutorConfig = { workspaceRoot: string };
export type SecretEnvFile = { contents: string };

export type DeploymentExecutionInput = {
  command: DeploymentCommand;
  repoUrl: string;
  ref: string;
  projectSlug: string;
  /** Decrypted by the trusted agent transport; never included in a command plan or log. */
  envFile: SecretEnvFile;
  healthUrl: string;
  dryRun?: boolean;
};
export type DeploymentExecutionResult = {
  ok: boolean;
  dryRun: boolean;
  commands: CommandPlan[];
  reason?: string;
};

/**
 * Spawn-based runner: argv only, no shell, bounded output and timeout. Tests
 * must inject a fake runner; calling this runner performs real side effects.
 */
export type SpawnedProcess = {
  stdout: { on(event: "data", listener: (chunk: Buffer) => void): unknown };
  stderr: { on(event: "data", listener: (chunk: Buffer) => void): unknown };
  once(event: "error" | "close", listener: (...args: any[]) => void): unknown;
  kill(signal: NodeJS.Signals): boolean;
};
export type SpawnFunction = (command: string, args: string[], options: { cwd?: string; shell: false; stdio: ["ignore", "pipe", "pipe"] }) => SpawnedProcess;

/**
 * Uses TERM followed by KILL and rejects after the grace period even when a
 * child ignores signals. The injectable spawn function keeps this testable
 * without executing a process.
 */
export function createSpawnProcessRunner(spawnChild: SpawnFunction = spawn as unknown as SpawnFunction, terminationGraceMs = TERMINATION_GRACE_MS): ProcessRunner {
  return {
    run(plan, timeoutMs) {
    return new Promise((resolveRun, reject) => {
      const child = spawnChild(plan.command, plan.args, { cwd: plan.cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let settled = false;
      let terminationTimer: NodeJS.Timeout | undefined;
      const append = (current: string, chunk: Buffer) => (current + chunk.toString()).slice(-MAX_OUTPUT_BYTES);
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutTimer);
        if (terminationTimer) clearTimeout(terminationTimer);
        callback();
      };
      child.stdout.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
      child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
      const timeoutTimer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        terminationTimer = setTimeout(() => {
          child.kill("SIGKILL");
          finish(() => reject(new Error(`Command timed out after ${Math.min(timeoutMs, MAX_TIMEOUT_MS)}ms`)));
        }, terminationGraceMs);
      }, Math.min(timeoutMs, MAX_TIMEOUT_MS));
      child.once("error", (error) => { finish(() => reject(error)); });
      child.once("close", (code) => { finish(() => resolveRun({ code: code ?? 1, stdout: redactOutput(stdout), stderr: redactOutput(stderr), timedOut })); });
    });
    }
  };
}

export const spawnProcessRunner = createSpawnProcessRunner();

export const nodeWorkspaceFilesystem: WorkspaceFilesystem = {
  create: async (path) => {
    const root = await realpath(dirname(path));
    assertTrustedWorkspaceRoot(root);
    try {
      const existing = await lstat(path);
      if (existing.isSymbolicLink()) throw new Error("Deployment workspace may not be a symbolic link");
      throw new Error("Deployment workspace already exists");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await mkdir(path, { mode: 0o700 });
    if (!isPathInside(root, await realpath(path))) throw new Error("Deployment workspace escaped its trusted root");
  },
  remove: async (path) => { await rm(path, { recursive: true, force: true }); },
  writeSecretFile: async (path, contents) => {
    await writeFile(path, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await chmod(path, 0o600);
  },
  removeSecretFile: async (path) => { await rm(path, { force: true }); }
};

export class AgentDeploymentExecutor {
  constructor(
    private readonly runner: ProcessRunner,
    private readonly commandBus: CommandBusClient,
    private readonly health: HealthProbe,
    private readonly logger: ExecutorLogger = { log: () => undefined },
    private readonly wait: (milliseconds: number) => Promise<void> = (milliseconds) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds)),
    private readonly filesystem: WorkspaceFilesystem = nodeWorkspaceFilesystem,
    private readonly config: ExecutorConfig = { workspaceRoot: `${AGENT_WORK_BASE}/workspaces` }
  ) {}

  async execute(input: DeploymentExecutionInput): Promise<DeploymentExecutionResult> {
    let plans: CommandPlan[];
    try {
      plans = createDeploymentPlan(input, this.config);
    } catch (error) {
      return this.fail(input.command, errorMessage(error), []);
    }
    if (input.dryRun) {
      const claimed = input.command.state === "claimed"
        ? input.command
        : await this.commandBus.claim(input.command.id, input.command.agentId);
      if (!claimed) return { ok: false, dryRun: true, commands: plans, reason: "Command could not be claimed" };
      await this.logger.log("info", `Dry-run deployment ${input.command.id}: ${plans.map(render).join("; ")}`);
      await this.commandBus.complete(claimed.id, { dryRun: true, commands: plans.map(publicPlan) });
      return { ok: true, dryRun: true, commands: plans };
    }

    const claimed = input.command.state === "claimed"
      ? input.command
      : await this.commandBus.claim(input.command.id, input.command.agentId);
    if (!claimed) return { ok: false, dryRun: false, commands: plans, reason: "Command could not be claimed" };

    const workspace = plans[0]?.args.at(-1);
    const envFilePath = resolve(workspace!, ".env");
    let composeStarted = false;
    let envFileWritten = false;
    let failure: unknown;
    try {
      await this.filesystem.create(workspace!);
      for (const plan of plans.slice(0, 3)) await this.run(plan);
      await this.filesystem.writeSecretFile(envFilePath, input.envFile.contents);
      envFileWritten = true;
      await this.run(plans[3]!);
      composeStarted = true;
      await this.run(plans.at(-1)!);
      await this.waitForHealth(input.healthUrl);
    } catch (error) {
      failure = error;
    }
    if (envFileWritten) {
      try { await this.filesystem.removeSecretFile(envFilePath); }
      catch (error) { failure ??= new Error("Secret env-file cleanup failed"); await this.logger.log("error", "Secret env-file cleanup failed"); }
    }
    if (failure) {
      if (composeStarted) await this.cleanup(plans.at(-1)!);
      if (workspace) await this.filesystem.remove(workspace);
      return this.fail(claimed, errorMessage(failure), plans);
    }
    await this.commandBus.complete(claimed.id, { imageTag: imageTag(input.projectSlug, claimed.id), workspace: "[REDACTED]" });
    return { ok: true, dryRun: false, commands: plans };
  }

  private async run(plan: CommandPlan): Promise<void> {
    const result = await this.runner.run(plan, MAX_TIMEOUT_MS);
    if (result.timedOut) throw new Error(`Timed out: ${plan.command}`);
    if (result.code !== 0) throw new Error(`Command failed: ${plan.command}: ${redactOutput(`${result.stderr}\n${result.stdout}`).trim().slice(0, 1024)}`);
  }

  private async waitForHealth(url: string): Promise<void> {
    for (const delay of [100, 200, 400, 800, 1_000]) {
      if (await this.health.probe(url, 1_000)) return;
      await this.wait(delay);
    }
    throw new Error("Health probe timed out");
  }

  private async cleanup(composeUp: CommandPlan): Promise<void> {
    const upIndex = composeUp.args.indexOf("up");
    const cleanup: CommandPlan = { command: "docker", args: [...composeUp.args.slice(0, upIndex), "down", "--remove-orphans"], cwd: composeUp.cwd };
    try { await this.runner.run(cleanup, 60_000); } catch { await this.logger.log("error", "Partial deployment cleanup failed"); }
  }

  private async fail(command: DeploymentCommand, reason: string, commands: CommandPlan[]): Promise<DeploymentExecutionResult> {
    const safeReason = redact(reason).slice(0, 1024);
    await this.logger.log("error", safeReason);
    await this.commandBus.fail(command.id, safeReason);
    return { ok: false, dryRun: false, commands, reason: safeReason };
  }
}

export function createDeploymentPlan(input: DeploymentExecutionInput, config: ExecutorConfig): CommandPlan[] {
  validateInput(input);
  const workspace = safeWorkspace(config.workspaceRoot, input.command.id);
  const tag = imageTag(input.projectSlug, input.command.id);
  const compose = ["compose", "--project-name", `deploylite-${input.projectSlug}`, "--project-directory", workspace, "up", "--detach", "--remove-orphans"];
  return [
    { command: "git", args: ["clone", "--no-checkout", "--depth", "1", input.repoUrl, workspace] },
    { command: "git", args: ["-C", workspace, "fetch", "--depth", "1", "origin", input.ref] },
    { command: "git", args: ["-C", workspace, "checkout", "--detach", "FETCH_HEAD"] },
    { command: "docker", args: ["build", "--tag", tag, workspace] },
    { command: "docker", args: compose, cwd: workspace }
  ];
}

export function imageTag(projectSlug: string, commandId: string): string {
  if (!SAFE_ID.test(projectSlug) || !SAFE_ID.test(commandId)) throw new Error("Invalid project slug or command id");
  return `deploylite/${projectSlug}:${commandId}`;
}

function validateInput(input: DeploymentExecutionInput): void {
  if (!SAFE_REPOSITORY.test(input.repoUrl) || hasCredentialedUrl(input.repoUrl)) throw new Error("Invalid repository URL");
  if (!SAFE_REF.test(input.ref) || input.ref.includes("..") || input.ref.startsWith("-")) throw new Error("Invalid git ref");
  imageTag(input.projectSlug, input.command.id);
  if (!/^https?:\/\/[A-Za-z0-9._:-]+(?:\/[^\s]*)?$/.test(input.healthUrl)) throw new Error("Invalid health URL");
  if (!input.envFile || typeof input.envFile.contents !== "string") throw new Error("A secret env-file is required for deployment");
}

function safeWorkspace(root: string, commandId: string): string {
  assertTrustedWorkspaceRoot(root);
  const base = resolve(root);
  const workspace = resolve(base, commandId);
  if (!isPathInside(base, workspace) || !SAFE_ID.test(commandId)) throw new Error("Invalid deployment workspace");
  return workspace;
}
function assertTrustedWorkspaceRoot(root: string): void {
  if (!root || !root.startsWith("/")) throw new Error("Deployment workspace root must be absolute");
  if (!isPathInside(AGENT_WORK_BASE, resolve(root))) throw new Error("Deployment workspace root is outside the allowed agent work base");
}
function isPathInside(base: string, target: string): boolean {
  const path = relative(resolve(base), resolve(target));
  return path === "" || (!path.startsWith("..") && !path.includes(`..${process.platform === "win32" ? "\\" : "/"}`));
}
function hasCredentialedUrl(value: string): boolean {
  if (!value.startsWith("https://")) return false;
  try { const url = new URL(value); return Boolean(url.username || url.password); }
  catch { return true; }
}
function publicPlan(plan: CommandPlan): Record<string, unknown> { return { command: plan.command, args: plan.args.map(redact), cwd: plan.cwd ? "[REDACTED]" : undefined }; }
function render(plan: CommandPlan): string { return `${plan.command} ${plan.args.map(redact).join(" ")}`; }
function redact(value: string): string { return redactSecrets(value.replace(/https:\/\/[^\s/@]+(?::[^\s/@]*)?@/g, "https://[REDACTED]@")); }
function redactOutput(value: string): string {
  return redact(value).split("\n").map((line) => /^[A-Za-z_][A-Za-z0-9_]{0,63}=/.test(line) ? `${line.slice(0, line.indexOf("="))}=[REDACTED]` : line).join("\n");
}
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : "Deployment executor failed"; }

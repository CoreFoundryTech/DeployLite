import { mkdir, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolve, relative } from "node:path";
import { redactSecrets } from "@deploylite/config";
import type { DeploymentCommand } from "@deploylite/contracts";

const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_TIMEOUT_MS = 10 * 60 * 1000;
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
export type WorkspaceFilesystem = { create(path: string): Promise<void>; remove(path: string): Promise<void> };

export type DeploymentExecutionInput = {
  command: DeploymentCommand;
  repoUrl: string;
  ref: string;
  projectSlug: string;
  workspaceRoot: string;
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
export const spawnProcessRunner: ProcessRunner = {
  run(plan, timeoutMs) {
    return new Promise((resolveRun, reject) => {
      const child = spawn(plan.command, plan.args, { cwd: plan.cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const append = (current: string, chunk: Buffer) => (current + chunk.toString()).slice(-MAX_OUTPUT_BYTES);
      child.stdout.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
      child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
      const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, Math.min(timeoutMs, MAX_TIMEOUT_MS));
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("close", (code) => { clearTimeout(timer); resolveRun({ code: code ?? 1, stdout: redactOutput(stdout), stderr: redactOutput(stderr), timedOut }); });
    });
  }
};

export const nodeWorkspaceFilesystem: WorkspaceFilesystem = {
  create: async (path) => { await mkdir(path, { recursive: true, mode: 0o700 }); },
  remove: async (path) => { await rm(path, { recursive: true, force: true }); }
};

export class AgentDeploymentExecutor {
  constructor(
    private readonly runner: ProcessRunner,
    private readonly commandBus: CommandBusClient,
    private readonly health: HealthProbe,
    private readonly logger: ExecutorLogger = { log: () => undefined },
    private readonly wait: (milliseconds: number) => Promise<void> = (milliseconds) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds)),
    private readonly filesystem: WorkspaceFilesystem = nodeWorkspaceFilesystem
  ) {}

  async execute(input: DeploymentExecutionInput): Promise<DeploymentExecutionResult> {
    let plans: CommandPlan[];
    try {
      plans = createDeploymentPlan(input);
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
    let composeStarted = false;
    try {
      await this.filesystem.create(workspace!);
      for (const plan of plans.slice(0, -1)) await this.run(plan);
      composeStarted = true;
      await this.run(plans.at(-1)!);
      await this.waitForHealth(input.healthUrl);
      await this.commandBus.complete(claimed.id, { imageTag: imageTag(input.projectSlug, claimed.id), workspace: "[REDACTED]" });
      return { ok: true, dryRun: false, commands: plans };
    } catch (error) {
      const reason = errorMessage(error);
      if (composeStarted) await this.cleanup(plans.at(-1)!);
      if (workspace) await this.filesystem.remove(workspace);
      return this.fail(claimed, reason, plans);
    }
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

export function createDeploymentPlan(input: DeploymentExecutionInput): CommandPlan[] {
  validateInput(input);
  const workspace = safeWorkspace(input.workspaceRoot, input.command.id);
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
  if (!SAFE_REPOSITORY.test(input.repoUrl)) throw new Error("Invalid repository URL");
  if (!SAFE_REF.test(input.ref) || input.ref.includes("..") || input.ref.startsWith("-")) throw new Error("Invalid git ref");
  imageTag(input.projectSlug, input.command.id);
  if (!/^https?:\/\/[A-Za-z0-9._:-]+(?:\/[^\s]*)?$/.test(input.healthUrl)) throw new Error("Invalid health URL");
}

function safeWorkspace(root: string, commandId: string): string {
  const base = resolve(root);
  const workspace = resolve(base, commandId);
  if (relative(base, workspace).startsWith("..") || !SAFE_ID.test(commandId)) throw new Error("Invalid deployment workspace");
  return workspace;
}
function publicPlan(plan: CommandPlan): Record<string, unknown> { return { command: plan.command, args: plan.args.map(redact), cwd: plan.cwd ? "[REDACTED]" : undefined }; }
function render(plan: CommandPlan): string { return `${plan.command} ${plan.args.map(redact).join(" ")}`; }
function redact(value: string): string { return redactSecrets(value); }
function redactOutput(value: string): string {
  return redact(value).split("\n").map((line) => /^[A-Za-z_][A-Za-z0-9_]{0,63}=/.test(line) ? `${line.slice(0, line.indexOf("="))}=[REDACTED]` : line).join("\n");
}
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : "Deployment executor failed"; }

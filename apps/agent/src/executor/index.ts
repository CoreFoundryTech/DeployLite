import { chmod, lstat, mkdir, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { basename, dirname, relative, resolve } from "node:path";
import { redactSecrets } from "@deploylite/config";
import type { DeploymentCommand } from "@deploylite/contracts";
import { redactEnvFileForLog } from "../redaction.js";
import { InMemoryManagedBuilderRegistry, type ManagedBuilderRegistry } from "../managed-builders.js";

const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_TIMEOUT_MS = 10 * 60 * 1000;
const TERMINATION_GRACE_MS = 5_000;
const AGENT_WORK_BASE = "/var/lib/deploylite";
const AGENT_SECRET_BASE = "/run/deploylite/secrets";
const BUILDKIT_CONFIG_PATH = "/etc/deploylite/buildkitd.toml";
const CLEANUP_ATTEMPTS = 4;
const CLEANUP_BACKOFF_MS = [250, 500, 1_000] as const;
const DEFAULT_HEALTH_STARTUP_GRACE_MS = 5_000;
const DEFAULT_HEALTH_DEADLINE_MS = 90_000;
const DEFAULT_HEALTH_PROBE_TIMEOUT_MS = 5_000;
const DEFAULT_HEALTH_RETRY_INTERVAL_MS = 2_000;
const REPAIR_RECORDS_PER_PASS = 16;
const MANAGED_LABEL = "com.deploylite.managed=true";
const MANAGED_PROJECT_LABEL = "com.deploylite.project-slug";
export const DEPLOYLITE_RUNTIME_NETWORK = "deploylite-runtime";
const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const SAFE_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const SAFE_NETWORK = /^deploylite-[a-z0-9][a-z0-9_.-]{0,52}$/;
const SAFE_REPOSITORY = /^https:\/\/[^\s]+$/;

export type CommandPlan = { command: string; args: string[]; cwd?: string };
export type ProcessResult = { code: number; stdout: string; stderr: string; timedOut: boolean };
export type ProcessRunner = { run(plan: CommandPlan, timeoutMs: number, signal?: AbortSignal): Promise<ProcessResult> };
// Structural subset of the Phase 5 command-bus port. Keeping this local avoids
// an agent -> API dependency while remaining compatible with the shared bus.
export type CommandBusClient = {
  claim(commandId: string, agentId: string): Promise<DeploymentCommand | null>;
  complete(commandId: string, output?: Record<string, unknown>): Promise<DeploymentCommand | null>;
  fail(commandId: string, reason: string): Promise<DeploymentCommand | null>;
  renewLease(commandId: string, agentId: string): Promise<DeploymentCommand | null>;
};
export type HealthProbe = { probe(url: string, timeoutMs: number, signal?: AbortSignal): Promise<boolean> };
export type RepositoryResolver = (hostname: string) => Promise<string[]>;
export type RepositoryOriginPolicy = { allowedHosts: string[]; resolve?: RepositoryResolver };
export type BuildContextInspector = (workspace: string) => Promise<void>;
export type HealthPolicy = {
  startupGraceMs?: number;
  deadlineMs?: number;
  probeTimeoutMs?: number;
  retryIntervalMs?: number;
  now?: () => number;
};
export type ExecutorLogger = { log(level: "info" | "error", message: string): Promise<void> | void };
export type WorkspaceFilesystem = {
  create(path: string): Promise<void>;
  remove(path: string): Promise<void>;
  createSecretDirectory(path: string): Promise<void>;
  removeSecretDirectory(path: string): Promise<void>;
  writeSecretFile(path: string, contents: string): Promise<void>;
  removeSecretFile(path: string): Promise<void>;
};
export type CleanupRepairRecord = { version: 1; commandId: string; projectSlug: string };
export type CleanupRepairStore = {
  load(): Promise<CleanupRepairRecord[]>;
  put(record: CleanupRepairRecord): Promise<void>;
  remove(commandId: string): Promise<void>;
  recoveryRequired?(): Promise<boolean>;
  completeRecovery?(records: CleanupRepairRecord[]): Promise<void>;
  recoveryProgress?(): Promise<{ cursor: number; overflowReason?: string }>;
  persistRecoveryPage?(records: CleanupRepairRecord[], cursor: number, overflowReason?: string): Promise<void>;
};

export type ExecutorConfig = { workspaceRoot: string; secretRoot: string };
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
  pid?: number;
  stdout: { on(event: "data", listener: (chunk: Buffer) => void): unknown };
  stderr: { on(event: "data", listener: (chunk: Buffer) => void): unknown };
  once(event: "error" | "close", listener: (...args: any[]) => void): unknown;
  kill(signal: NodeJS.Signals): boolean;
};
export type SpawnFunction = (command: string, args: string[], options: { cwd?: string; detached: boolean; shell: false; stdio: ["ignore", "pipe", "pipe"] }) => SpawnedProcess;
export type KillProcessGroup = (pid: number, signal: NodeJS.Signals) => void;

/**
 * Uses a detached process group on POSIX and TERM followed by KILL. This only
 * bounds the local CLI process tree: Docker daemon work is not cancellable by
 * killing its client, so the executor also performs labelled resource cleanup.
 */
export function createSpawnProcessRunner(
  spawnChild: SpawnFunction = spawn as unknown as SpawnFunction,
  terminationGraceMs = TERMINATION_GRACE_MS,
  killProcessGroup: KillProcessGroup = process.kill
): ProcessRunner {
  return {
    run(plan, timeoutMs, signal) {
    return new Promise((resolveRun, reject) => {
      const detached = process.platform !== "win32";
      const child = spawnChild(plan.command, plan.args, { cwd: plan.cwd, detached, shell: false, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let settled = false;
      let terminationTimer: NodeJS.Timeout | undefined;
      let timeoutTimer: NodeJS.Timeout | undefined;
      const append = (current: string, chunk: Buffer) => (current + chunk.toString()).slice(-MAX_OUTPUT_BYTES);
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        if (timeoutTimer) clearTimeout(timeoutTimer);
        if (terminationTimer) clearTimeout(terminationTimer);
        signal?.removeEventListener("abort", abort);
        callback();
      };
      child.stdout.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
      child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
      const terminate = (signal: NodeJS.Signals) => {
        if (detached && child.pid) {
          try { killProcessGroup(-child.pid, signal); return; } catch { /* fall back to the direct child */ }
        }
        child.kill(signal);
      };
      const abort = () => {
        terminate("SIGKILL");
        finish(() => reject(new Error("Deployment execution lease was lost")));
      };
      if (signal?.aborted) return abort();
      signal?.addEventListener("abort", abort, { once: true });
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        terminate("SIGTERM");
        terminationTimer = setTimeout(() => {
          terminate("SIGKILL");
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
  createSecretDirectory: async (path) => { await mkdir(path, { recursive: false, mode: 0o700 }); },
  removeSecretDirectory: async (path) => { await rm(path, { recursive: true, force: true }); },
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
    private readonly wait: (milliseconds: number, signal?: AbortSignal) => Promise<void> = (milliseconds, signal) => new Promise((resolveWait) => {
      if (signal?.aborted) return resolveWait();
      const timer = setTimeout(() => { signal?.removeEventListener("abort", finish); resolveWait(); }, milliseconds);
      const finish = () => { clearTimeout(timer); resolveWait(); };
      signal?.addEventListener("abort", finish, { once: true });
    }),
    private readonly filesystem: WorkspaceFilesystem = nodeWorkspaceFilesystem,
    private readonly config: ExecutorConfig = { workspaceRoot: `${AGENT_WORK_BASE}/workspaces`, secretRoot: AGENT_SECRET_BASE },
    private readonly cleanupRepairs: CleanupRepairStore = { load: async () => [], put: async () => undefined, remove: async () => undefined },
    private readonly managedBuilders: ManagedBuilderRegistry = new InMemoryManagedBuilderRegistry(),
    private readonly healthPolicy: HealthPolicy = {},
    private readonly repositoryPolicy: RepositoryOriginPolicy = { allowedHosts: ["github.com"] },
    private readonly inspectBuildContext: BuildContextInspector = assertSafeBuildContext
  ) {}

  async execute(input: DeploymentExecutionInput, signal?: AbortSignal): Promise<DeploymentExecutionResult> {
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
      await this.safeLog("info", `Dry-run deployment ${input.command.id}: ${plans.map(render).join("; ")}`);
      await this.commandBus.complete(claimed.id, { dryRun: true, commands: plans.map(publicPlan) });
      return { ok: true, dryRun: true, commands: plans };
    }

    const claimed = input.command.state === "claimed"
      ? input.command
      : await this.commandBus.claim(input.command.id, input.command.agentId);
    if (!claimed) return { ok: false, dryRun: false, commands: plans, reason: "Command could not be claimed" };

    const workspace = plans[0]?.args.at(-1);
    const secretDirectory = safeSecretDirectory(this.config.secretRoot, claimed.id);
    const envFilePath = resolve(secretDirectory, "runtime.env");
    let managedResourcesAttempted = false;
    let envFileWritten = false;
    let failure: unknown;
    try {
      await this.assertRepositoryOrigin(input.repoUrl);
      await this.filesystem.create(workspace!);
      // Resolve immediately before git starts as well as before workspace work,
      // reducing the DNS-rebinding window without claiming to eliminate TOCTOU.
      await this.assertRepositoryOrigin(input.repoUrl);
      for (const plan of plans.slice(0, 3)) await this.run(plan, signal);
      await this.inspectBuildContext(workspace!);
      await this.managedBuilders.put({ version: 1, commandId: claimed.id, builderName: builderName(claimed.id) });
      managedResourcesAttempted = true;
      for (const plan of plans.slice(3, -1)) await this.run(plan, signal);
      await this.filesystem.createSecretDirectory(secretDirectory);
      envFileWritten = true;
      await this.filesystem.writeSecretFile(envFilePath, input.envFile.contents);
      await this.run(plans.at(-1)!, signal);
      await this.waitForHealth(input.healthUrl, signal);
    } catch (error) {
      failure = error;
    }
    const secretCleanupError = await this.cleanupSecret(envFileWritten, envFilePath, secretDirectory);
    failure ??= secretCleanupError;
    if (failure) {
      if (managedResourcesAttempted) {
        const cleaned = await this.reconcileRuntime(input, true);
        if (!cleaned) failure = new Error(`${errorMessage(failure)}; managed resource cleanup incomplete; repair remains scheduled`);
      }
      if (workspace) await this.bestEffort("Deployment workspace cleanup failed", () => this.filesystem.remove(workspace));
      return this.fail(claimed, errorMessage(failure), plans);
    }
    const retired = await this.retirePriorRuntimes(input, signal);
    if (!retired) {
      await this.reconcileRuntime(input, false, signal);
      if (workspace) await this.bestEffort("Deployment workspace cleanup failed", () => this.filesystem.remove(workspace));
      return this.fail(claimed, "Replacement cleanup incomplete; the healthy new runtime remains active and deterministic repair is scheduled.", plans);
    }
    const buildResourcesClean = await this.reconcileRuntime(input, false);
    if (!buildResourcesClean) {
      const rollbackClean = await this.reconcileRuntime(input, true);
      if (workspace) await this.bestEffort("Deployment workspace cleanup failed", () => this.filesystem.remove(workspace));
      return this.fail(claimed, rollbackClean
        ? "Managed build resource cleanup exceeded the initial bounded window; deployment was rolled back safely."
        : "Managed build resource cleanup incomplete; repair remains scheduled.", plans);
    }
    if (workspace) await this.bestEffort("Deployment workspace cleanup failed", () => this.filesystem.remove(workspace));
    await this.commandBus.complete(claimed.id, { imageTag: imageTag(input.projectSlug, claimed.id), workspace: "[REDACTED]" });
    return { ok: true, dryRun: false, commands: plans };
  }

  async reconcile(input: DeploymentExecutionInput): Promise<DeploymentExecutionResult> {
    let plans: CommandPlan[] = [];
    try { plans = createDeploymentPlan(input, this.config); } catch { /* cleanup still uses validated identifiers below */ }
    const cleaned = await this.reconcileRuntime(input, true);
    const workspace = plans[0]?.args.at(-1);
    if (workspace) await this.bestEffort("Deployment workspace cleanup failed", () => this.filesystem.remove(workspace));
    const secretDirectory = safeSecretDirectory(this.config.secretRoot, input.command.id);
    await this.bestEffort("Deployment secret cleanup failed", () => this.filesystem.removeSecretDirectory(secretDirectory));
    return this.fail(input.command, cleaned
      ? "Agent restarted with an owned claimed command; execution was not retried."
      : "Agent restarted with an owned claimed command; managed resource cleanup incomplete; repair remains scheduled.", plans);
  }

  async reconcilePending(signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted) return false;
    const recoveryRequired = this.cleanupRepairs.recoveryRequired && await this.cleanupRepairs.recoveryRequired();
    if (recoveryRequired) {
      const reconstructed = await this.discoverRecoveryRecords(signal);
      if (reconstructed === null || !this.cleanupRepairs.completeRecovery) {
        await this.safeLog("error", "Managed cleanup repair recovery discovery failed; recovery will retry.");
        return false;
      }
      const progress = this.cleanupRepairs.recoveryProgress && await this.cleanupRepairs.recoveryProgress();
      if (progress?.overflowReason) return false;
      if (reconstructed.length > 256) {
        try { await this.cleanupRepairs.persistRecoveryPage?.([], progress?.cursor ?? 0, "Managed cleanup recovery exceeds the 256-record limit"); }
        catch { await this.safeLog("error", "Managed cleanup repair recovery overflow marker could not be persisted; recovery will retry."); }
        return false;
      }
      const cursor = progress?.cursor ?? 0;
      const page = reconstructed.slice(cursor, cursor + REPAIR_RECORDS_PER_PASS);
      try {
        if (this.cleanupRepairs.persistRecoveryPage) await this.cleanupRepairs.persistRecoveryPage(page, cursor + page.length);
        else if (cursor === 0) { await this.cleanupRepairs.completeRecovery(reconstructed); return this.reconcilePending(signal); }
      } catch { await this.safeLog("error", "Managed cleanup repair recovery state could not be persisted; recovery will retry."); return false; }
      if (cursor + page.length < reconstructed.length) return false;
      try { await this.cleanupRepairs.completeRecovery(await this.cleanupRepairs.load()); }
      catch { await this.safeLog("error", "Managed cleanup repair recovery state could not be persisted; recovery will retry."); return false; }
    }
    let complete = true;
    const records = await this.cleanupRepairs.load();
    for (const record of records.slice(0, REPAIR_RECORDS_PER_PASS)) {
      if (signal?.aborted) return false;
      const input = repairInput(record);
      if (!(await this.reconcileRuntime(input, true, signal))) complete = false;
    }
    return complete && records.length <= REPAIR_RECORDS_PER_PASS;
  }

  private async run(plan: CommandPlan, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new Error("Deployment execution lease was lost");
    const result = signal ? await this.runner.run(plan, MAX_TIMEOUT_MS, signal) : await this.runner.run(plan, MAX_TIMEOUT_MS);
    if (result.timedOut) throw new Error(`Timed out: ${plan.command}`);
    if (result.code !== 0) throw new Error(`Command failed: ${plan.command}: ${redactOutput(`${result.stderr}\n${result.stdout}`).trim().slice(0, 1024)}`);
    if (plan.args[0] === "inspect" && plan.args.includes("{{json .HostConfig}}")) assertBoundedBuilderInspection(result.stdout);
  }

  private async waitForHealth(url: string, signal?: AbortSignal): Promise<void> {
    const startupGraceMs = boundedHealthDuration(this.healthPolicy.startupGraceMs, DEFAULT_HEALTH_STARTUP_GRACE_MS, 0);
    const deadlineMs = boundedHealthDuration(this.healthPolicy.deadlineMs, DEFAULT_HEALTH_DEADLINE_MS);
    const probeTimeoutMs = boundedHealthDuration(this.healthPolicy.probeTimeoutMs, DEFAULT_HEALTH_PROBE_TIMEOUT_MS);
    const retryIntervalMs = boundedHealthDuration(this.healthPolicy.retryIntervalMs, DEFAULT_HEALTH_RETRY_INTERVAL_MS);
    const now = this.healthPolicy.now ?? Date.now;
    const deadline = now() + deadlineMs;
    if (startupGraceMs > 0) await this.wait(Math.min(startupGraceMs, deadlineMs), signal);
    while (now() < deadline) {
      if (signal?.aborted) throw new Error("Deployment execution lease was lost");
      const remaining = deadline - now();
      const probeSignal = composeAbortSignals(signal, Math.min(probeTimeoutMs, remaining));
      try {
        if (await this.health.probe(url, Math.min(probeTimeoutMs, remaining), probeSignal.signal)) return;
      } finally {
        probeSignal.dispose();
      }
      if (signal?.aborted) throw new Error("Deployment execution lease was lost");
      const delay = Math.min(retryIntervalMs, deadline - now());
      if (delay > 0) await this.wait(delay, signal);
    }
    throw new Error("Health probe timed out");
  }

  private async assertRepositoryOrigin(repoUrl: string): Promise<void> {
    const origin = parseRepositoryOrigin(repoUrl, this.repositoryPolicy.allowedHosts);
    const resolveHostname = this.repositoryPolicy.resolve ?? defaultRepositoryResolver;
    let addresses: string[];
    try { addresses = await resolveHostname(origin.hostname); }
    catch { throw new Error("Repository origin resolution failed"); }
    if (addresses.length === 0 || addresses.some((address) => isForbiddenRepositoryAddress(address))) {
      throw new Error("Repository origin is not permitted");
    }
  }

  /** Retire only exact, label-backed DeployLite runtimes after the replacement is healthy. */
  private async retirePriorRuntimes(input: DeploymentExecutionInput, signal?: AbortSignal): Promise<boolean> {
    const query: CommandPlan = {
      command: "docker",
      args: ["ps", "--all", "--format", "{{.ID}}\t{{.Names}}\t{{.Label \"com.deploylite.managed\"}}\t{{.Label \"com.deploylite.command-id\"}}\t{{.Label \"com.deploylite.project-slug\"}}", "--filter", `label=${MANAGED_LABEL}`, "--filter", `label=${MANAGED_PROJECT_LABEL}=${input.projectSlug}`]
    };
    let result: ProcessResult;
    try { result = await this.runCleanupPlan(query, signal); }
    catch { return false; }
    if (result.code !== 0) return false;
    const previous = result.stdout.split("\n").map((line) => managedRuntimeFromLine(line, input.projectSlug)).filter((entry): entry is { id: string; commandId: string } => entry !== null && entry.commandId !== input.command.id);
    for (const runtime of previous) {
      const oldInput = { ...input, command: { ...input.command, id: runtime.commandId } };
      try { await this.cleanupRepairs.put(cleanupRepairRecord(oldInput)); }
      catch { return false; }
      try {
        if ((await this.runCleanupPlan({ command: "docker", args: ["stop", "--time", "5", runtime.id] }, signal)).code !== 0) return false;
        if ((await this.runCleanupPlan({ command: "docker", args: ["rm", runtime.id] }, signal)).code !== 0) return false;
      } catch { return false; }
      if (!(await this.reconcileRuntime(oldInput, true, signal))) return false;
    }
    return true;
  }

  private async cleanupSecret(written: boolean, envFilePath: string, secretDirectory: string): Promise<Error | undefined> {
    let cleanupError: Error | undefined;
    if (written) {
      try { await this.filesystem.removeSecretFile(envFilePath); }
      catch { cleanupError = new Error("Secret env-file cleanup failed"); await this.safeLog("error", cleanupError.message); }
    }
    try { await this.filesystem.removeSecretDirectory(secretDirectory); }
    catch { cleanupError ??= new Error("Secret directory cleanup failed"); await this.safeLog("error", "Secret directory cleanup failed"); }
    return cleanupError;
  }

  private async reconcileRuntime(input: DeploymentExecutionInput, includeRuntime: boolean, signal?: AbortSignal): Promise<boolean> {
    const record = cleanupRepairRecord(input);
    try { await this.cleanupRepairs.put(record); }
    catch {
      await this.safeLog("error", `Managed resource cleanup repair state could not be persisted for command ${input.command.id}.`);
      return false;
    }
    let consecutiveAbsent = 0;
    for (let attempt = 0; attempt < CLEANUP_ATTEMPTS; attempt += 1) {
      if (signal?.aborted) return false;
      const discovered = await this.discoverManagedResources(input, includeRuntime, signal);
      if (discovered === null) {
        consecutiveAbsent = 0;
      } else if (discovered.length === 0) {
        consecutiveAbsent += 1;
        if (attempt === CLEANUP_ATTEMPTS - 1 && consecutiveAbsent >= 2) {
          await this.cleanupRepairs.remove(input.command.id);
          await this.managedBuilders.remove(input.command.id);
          return true;
        }
      } else {
        consecutiveAbsent = 0;
        for (const plan of discovered) {
          if (signal?.aborted) return false;
          await this.bestEffort("Managed Docker resource cleanup failed", () => this.runCleanupPlan(plan, signal));
        }
      }
      if (attempt < CLEANUP_ATTEMPTS - 1) await this.wait(CLEANUP_BACKOFF_MS[Math.min(attempt, CLEANUP_BACKOFF_MS.length - 1)]!);
    }
    await this.safeLog("error", `Managed resource cleanup incomplete for command ${input.command.id}; repair remains scheduled.`);
    return false;
  }

  private async discoverManagedResources(input: DeploymentExecutionInput, includeRuntime: boolean, signal?: AbortSignal): Promise<CommandPlan[] | null> {
    const queries = createRuntimeCleanupPlans(input, includeRuntime);
    const removals: CommandPlan[] = [];
    for (const query of queries) {
      let result: ProcessResult;
      try { result = await this.runCleanupPlan(query, signal); }
      catch { return null; }
      if (result.code !== 0) return null;
      const values = result.stdout.split(/\s+/).filter(Boolean);
      if (query.args[0] === "buildx") {
        const builder = builderName(input.command.id);
        const registered = await this.managedBuilders.load();
        if (registered.some((entry) => entry.commandId === input.command.id && entry.builderName === builder) && values.includes(builder)) removals.push({ command: "docker", args: ["buildx", "rm", "--force", builder] });
      } else {
        if (values.some((value) => !/^[a-f0-9]{12,64}$/i.test(value))) return null;
        for (const value of values) removals.push({ command: "docker", args: removalArgs(query, value) });
      }
    }
    return removals;
  }

  /** Discovery only reconstructs records; it never removes a resource. */
  private async discoverRecoveryRecords(signal?: AbortSignal): Promise<CleanupRepairRecord[] | null> {
    const queries: CommandPlan[] = [
      { command: "docker", args: ["ps", "--all", "--format", "{{.Names}}\t{{.Label \"com.deploylite.managed\"}}\t{{.Label \"com.deploylite.command-id\"}}\t{{.Label \"com.deploylite.project-slug\"}}"] },
      { command: "docker", args: ["image", "ls", "--format", "{{.Repository}}\t{{.Tag}}\t{{.Label \"com.deploylite.managed\"}}\t{{.Label \"com.deploylite.command-id\"}}\t{{.Label \"com.deploylite.project-slug\"}}"] },
      { command: "docker", args: ["network", "ls", "--format", "{{.Name}}\t{{.Label \"com.deploylite.managed\"}}\t{{.Label \"com.deploylite.command-id\"}}\t{{.Label \"com.deploylite.project-slug\"}}"] },
      { command: "docker", args: ["buildx", "ls", "--format", "{{.Name}}"] }
    ];
    const records = new Map<string, CleanupRepairRecord>();
    for (const query of queries) {
      let result: ProcessResult;
      try { result = await this.runCleanupPlan(query, signal); }
      catch { return null; }
      if (result.code !== 0 || signal?.aborted) return null;
      for (const line of result.stdout.split("\n").filter(Boolean)) {
        const record = recoveryRecordFromLine(query.args[0]!, line);
        if (record) records.set(record.commandId, record);
      }
    }
    for (const entry of await this.managedBuilders.load()) {
      if (!records.has(entry.commandId)) records.set(entry.commandId, { version: 1, commandId: entry.commandId, projectSlug: "recovery" });
    }
    return [...records.values()].sort((a, b) => a.commandId.localeCompare(b.commandId));
  }

  private async runCleanupPlan(plan: CommandPlan, signal?: AbortSignal): Promise<ProcessResult> {
    return signal ? this.runner.run(plan, 60_000, signal) : this.runner.run(plan, 60_000);
  }

  private async bestEffort(message: string, operation: () => Promise<unknown>): Promise<void> {
    try { await operation(); } catch (error) { await this.safeLog("error", `${message}: ${errorMessage(error)}`); }
  }

  private async safeLog(level: "info" | "error", message: string): Promise<void> {
    try { await this.logger.log(level, redactOutput(message)); } catch { /* logging must not block terminal state */ }
  }

  private async fail(command: DeploymentCommand, reason: string, commands: CommandPlan[]): Promise<DeploymentExecutionResult> {
    const safeReason = redactOutput(reason).slice(0, 1024);
    await this.safeLog("error", safeReason);
    await this.commandBus.fail(command.id, safeReason);
    return { ok: false, dryRun: false, commands, reason: safeReason };
  }
}

export function createDeploymentPlan(input: DeploymentExecutionInput, config: ExecutorConfig): CommandPlan[] {
  validateInput(input);
  const workspace = safeWorkspace(config.workspaceRoot, input.command.id);
  const tag = imageTag(input.projectSlug, input.command.id);
  const envFilePath = resolve(safeSecretDirectory(config.secretRoot, input.command.id), "runtime.env");
  const container = containerName(input.projectSlug, input.command.id);
  const builder = builderName(input.command.id);
  const buildNetwork = buildNetworkName(input.command.id);
  const runtime: CommandPlan = {
    command: "docker",
    args: [
      "run", "--detach", "--name", container,
      "--restart", "unless-stopped",
      "--network", DEPLOYLITE_RUNTIME_NETWORK,
      "--label", MANAGED_LABEL,
      "--label", `com.deploylite.command-id=${input.command.id}`,
      "--label", `${MANAGED_PROJECT_LABEL}=${input.projectSlug}`,
      "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
      "--pids-limit", "256", "--memory", "1g", "--cpus", "1",
      "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m",
      // Docker CLI reads --env-file locally before creating the container;
      // this path belongs in the agent tmpfs, not on the daemon host.
      "--env-file", envFilePath,
      tag
    ]
  };
  assertSafeRuntimePlan(runtime, DEPLOYLITE_RUNTIME_NETWORK);
  return [
    { command: "git", args: ["clone", "--no-checkout", "--depth", "1", input.repoUrl, workspace] },
    { command: "git", args: ["-C", workspace, "fetch", "--depth", "1", "origin", input.ref] },
    { command: "git", args: ["-C", workspace, "checkout", "--detach", "FETCH_HEAD"] },
    { command: "docker", args: ["network", "create", "--driver", "bridge", "--label", MANAGED_LABEL, "--label", `com.deploylite.command-id=${input.command.id}`, "--label", `${MANAGED_PROJECT_LABEL}=${input.projectSlug}`, buildNetwork] },
    {
      command: "docker",
      args: [
        "buildx", "create", "--name", builder, "--driver", "docker-container",
        "--driver-opt", `network=${buildNetwork},memory=1g,memory-swap=1g,cpu-period=100000,cpu-quota=100000,restart-policy=no`,
        "--buildkitd-config", BUILDKIT_CONFIG_PATH
      ]
    },
    { command: "docker", args: ["buildx", "inspect", "--builder", builder, "--bootstrap"] },
    { command: "docker", args: ["update", "--pids-limit", "256", builderContainerName(builder)] },
    { command: "docker", args: ["inspect", "--format", "{{json .HostConfig}}", builderContainerName(builder)] },
    {
      command: "docker",
      args: [
        "buildx", "build", "--builder", builder, "--network", "none", "--progress", "plain",
        "--label", MANAGED_LABEL,
        "--label", `com.deploylite.command-id=${input.command.id}`,
        "--label", `${MANAGED_PROJECT_LABEL}=${input.projectSlug}`,
        "--output", `type=docker,name=${tag}`,
        workspace
      ]
    },
    runtime
  ];
}

export function createRuntimeCleanupPlans(input: DeploymentExecutionInput, includeRuntime = true): CommandPlan[] {
  const labels = ["--filter", `label=${MANAGED_LABEL}`, "--filter", `label=com.deploylite.command-id=${input.command.id}`];
  const plans: CommandPlan[] = [
    { command: "docker", args: ["buildx", "ls", "--format", "{{.Name}}"] },
    { command: "docker", args: ["network", "ls", "--quiet", "--filter", `name=^${buildNetworkName(input.command.id)}$`, ...labels] }
  ];
  if (includeRuntime) {
    plans.unshift(
      { command: "docker", args: ["ps", "--all", "--quiet", "--filter", `name=^/${containerName(input.projectSlug, input.command.id)}$`, ...labels] },
      { command: "docker", args: ["image", "ls", "--quiet", "--no-trunc", "--filter", `reference=${imageTag(input.projectSlug, input.command.id)}`, ...labels] }
    );
  }
  return plans;
}

export function assertSafeRuntimePlan(plan: CommandPlan, trustedNetwork = DEPLOYLITE_RUNTIME_NETWORK): true {
  const forbidden = ["--privileged", "--pid", "--ipc", "--device", "--cap-add", "--volume", "--mount", "-v"];
  if (plan.command !== "docker" || plan.args[0] !== "run") throw new Error("Runtime plan must be a controlled docker run");
  if (plan.args.some((arg) => forbidden.some((option) => arg === option || arg.startsWith(`${option}=`)) || arg.includes("docker.sock"))) {
    throw new Error("Unsafe Docker runtime option rejected");
  }
  if (!SAFE_NETWORK.test(trustedNetwork) || plan.args.filter((arg) => arg === "--network").length !== 1 || valueAfter(plan.args, "--network") !== trustedNetwork || plan.args.some((arg) => arg.startsWith("--network="))) {
    throw new Error("Runtime plan must use the trusted DeployLite network");
  }
  for (const required of ["--network", "--restart", "--read-only", "--cap-drop", "--security-opt", "--pids-limit", "--memory", "--cpus", "--env-file"]) {
    if (!plan.args.includes(required)) throw new Error(`Runtime plan is missing ${required}`);
  }
  if (valueAfter(plan.args, "--cap-drop") !== "ALL" || valueAfter(plan.args, "--security-opt") !== "no-new-privileges") {
    throw new Error("Runtime plan weakens container isolation");
  }
  if (valueAfter(plan.args, "--restart") !== "unless-stopped" || plan.args.some((arg) => arg.startsWith("--restart="))) {
    throw new Error("Runtime plan must use the trusted restart policy");
  }
  return true;
}

export function imageTag(projectSlug: string, commandId: string): string {
  if (!SAFE_ID.test(projectSlug) || !SAFE_ID.test(commandId)) throw new Error("Invalid project slug or command id");
  return `deploylite/${projectSlug}:${commandId}`;
}

export function containerName(projectSlug: string, commandId: string): string {
  if (!SAFE_ID.test(projectSlug) || !SAFE_ID.test(commandId)) throw new Error("Invalid project slug or command id");
  const name = `deploylite-${commandId}`;
  if (name.length > 63) throw new Error("Runtime container name exceeds the trusted DNS label limit");
  return name;
}

export function builderName(commandId: string): string {
  if (!SAFE_ID.test(commandId)) throw new Error("Invalid command id for builder");
  const name = `deploylite-${commandId}`;
  if (name.length > 63) throw new Error("Buildx builder name exceeds the trusted limit");
  return name;
}

export function buildNetworkName(commandId: string): string {
  if (!SAFE_ID.test(commandId)) throw new Error("Invalid command id for build network");
  const name = `deploylite-build-${commandId}`;
  if (name.length > 63) throw new Error("Build network name exceeds the trusted limit");
  return name;
}

function builderContainerName(builder: string): string {
  return `buildx_buildkit_${builder}0`;
}

function assertBoundedBuilderInspection(stdout: string): void {
  let hostConfig: Record<string, unknown>;
  try { hostConfig = JSON.parse(stdout) as Record<string, unknown>; }
  catch { throw new Error("Bounded BuildKit builder inspection was invalid"); }
  if (
    hostConfig.Memory !== 1024 ** 3 || hostConfig.MemorySwap !== 1024 ** 3 ||
    hostConfig.CpuPeriod !== 100_000 || hostConfig.CpuQuota !== 100_000 || hostConfig.PidsLimit !== 256 ||
    typeof hostConfig.NetworkMode !== "string" || !hostConfig.NetworkMode.startsWith("deploylite-build-")
  ) throw new Error("Bounded BuildKit builder is unavailable");
}

function cleanupRepairRecord(input: DeploymentExecutionInput): CleanupRepairRecord {
  imageTag(input.projectSlug, input.command.id);
  return { version: 1, commandId: input.command.id, projectSlug: input.projectSlug };
}

function repairInput(record: CleanupRepairRecord): DeploymentExecutionInput {
  const command: DeploymentCommand = {
    id: record.commandId,
    deploymentId: record.commandId,
    agentId: record.commandId,
    kind: "start",
    state: "failed",
    payload: {},
    requestedBy: null,
    requestId: record.commandId,
    correlationId: record.commandId,
    issuedAt: new Date(0).toISOString(),
    claimedAt: null,
    leaseExpiresAt: null,
    completedAt: null,
    failureReason: null
  };
  return { command, repoUrl: "https://invalid.example/repository.git", ref: "repair", projectSlug: record.projectSlug, envFile: { contents: "" }, healthUrl: `http://${containerName(record.projectSlug, record.commandId)}:1/` };
}

function removalArgs(query: CommandPlan, id: string): string[] {
  if (query.args[0] === "ps") return ["rm", "--force", id];
  if (query.args[0] === "image") return ["image", "rm", "--force", id];
  if (query.args[0] === "network") return ["network", "rm", id];
  throw new Error("Unsupported managed cleanup query");
}

function recoveryRecordFromLine(kind: string, line: string): CleanupRepairRecord | null {
  if (kind === "buildx") return null; // A builder name alone is never a managed marker.
  const fields = line.split("\t");
  const [name, managed, commandId, projectSlug, ...rest] = kind === "image"
    ? [`${fields[0] ?? ""}:${fields[1] ?? ""}`, fields[2], fields[3], fields[4], ...fields.slice(5)]
    : fields;
  if (rest.length > 0 || managed !== "true" || !commandId || !projectSlug || !SAFE_ID.test(commandId) || !SAFE_ID.test(projectSlug)) return null;
  try {
    const matches = kind === "ps"
      ? name === containerName(projectSlug, commandId)
      : kind === "image"
        ? name === imageTag(projectSlug, commandId)
        : kind === "network" && name === buildNetworkName(commandId);
    return matches ? { version: 1, commandId, projectSlug } : null;
  } catch { return null; }
}

function validateInput(input: DeploymentExecutionInput): void {
  if (!SAFE_REPOSITORY.test(input.repoUrl) || hasCredentialedUrl(input.repoUrl)) throw new Error("Invalid repository URL");
  if (!SAFE_REF.test(input.ref) || input.ref.includes("..") || input.ref.startsWith("-")) throw new Error("Invalid git ref");
  imageTag(input.projectSlug, input.command.id);
  let healthUrl: URL;
  try { healthUrl = new URL(input.healthUrl); }
  catch { throw new Error("Invalid health URL"); }
  const port = Number(healthUrl.port);
  if (healthUrl.protocol !== "http:" || healthUrl.username || healthUrl.password || healthUrl.hostname !== containerName(input.projectSlug, input.command.id) || !Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("Health URL must target the managed runtime container and internal port");
  }
  if (!input.envFile || typeof input.envFile.contents !== "string") throw new Error("A secret env-file is required for deployment");
}

/**
 * Reject remote ADD sources before creating BuildKit resources. This is a
 * deliberately small, fail-closed Dockerfile parser: it only accepts complete
 * logical instructions and treats malformed continuations as unsafe.
 */
export async function assertSafeBuildContext(workspace: string): Promise<void> {
  const dockerfiles = await discoverDockerfiles(workspace);
  if (dockerfiles.length === 0) throw new Error("Build context Dockerfile is missing");
  for (const path of dockerfiles) validateDockerfileAddInstructions(await readFile(path, "utf8"));
}

async function discoverDockerfiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch { throw new Error("Build context inspection failed"); }
    for (const entry of entries) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() && /^dockerfile(?:\.[a-z0-9_.-]+)?$/i.test(basename(path))) files.push(path);
    }
  }
  return files;
}

export function validateDockerfileAddInstructions(contents: string): void {
  let instruction = "";
  let continuation = false;
  for (const rawLine of contents.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!continuation && (!line || line.startsWith("#"))) continue;
    if (continuation && (!line || line.startsWith("#"))) throw new Error("Dockerfile continuation is invalid");
    const continues = /\\\s*$/.test(rawLine);
    instruction += `${instruction ? " " : ""}${rawLine.replace(/\\\s*$/, "").trim()}`;
    continuation = continues;
    if (continuation) continue;
    validateDockerfileInstruction(instruction);
    instruction = "";
  }
  if (continuation || instruction) {
    if (continuation) throw new Error("Dockerfile continuation is invalid");
    validateDockerfileInstruction(instruction);
  }
}

function validateDockerfileInstruction(instruction: string): void {
  const match = instruction.match(/^\s*([a-z]+)\b([\s\S]*)$/i);
  if (!match) throw new Error("Dockerfile instruction is invalid");
  const operation = match[1]!.toUpperCase();
  if (operation !== "ADD" && operation !== "COPY") return;
  const argumentsText = match[2]!.trim();
  if (!argumentsText) throw new Error(`Dockerfile ${operation} instruction is invalid`);
  if (argumentsText.startsWith("[")) {
    let argumentsArray: unknown;
    try { argumentsArray = JSON.parse(argumentsText); }
    catch { throw new Error(`Dockerfile ${operation} instruction is invalid`); }
    if (!Array.isArray(argumentsArray) || argumentsArray.length < 2 || argumentsArray.some((argument) => typeof argument !== "string")) {
      throw new Error(`Dockerfile ${operation} instruction is invalid`);
    }
    if (operation === "ADD" && argumentsArray.slice(0, -1).some(isRemoteDockerfileSource)) {
      throw new Error("Remote ADD sources are not permitted");
    }
    return;
  }
  if (operation !== "ADD") return;
  // This catches HTTP(S), protocol-relative, and scheme/git-like forms in
  // shell and JSON-array ADD syntax without disclosing the source in errors.
  if (isRemoteDockerfileSource(argumentsText)) {
    throw new Error("Remote ADD sources are not permitted");
  }
}

function isRemoteDockerfileSource(value: string): boolean {
  return /(?:^|[\s[\]",'])(?:[a-z][a-z0-9+.-]*:\/\/|\/\/|git@)/i.test(value);
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
function safeSecretDirectory(root: string, commandId: string): string {
  if (resolve(root) !== AGENT_SECRET_BASE || !SAFE_ID.test(commandId)) throw new Error("Invalid deployment secret directory");
  const directory = resolve(root, commandId);
  if (!isPathInside(root, directory)) throw new Error("Deployment secret directory escaped its trusted root");
  return directory;
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
function parseRepositoryOrigin(value: string, allowedHosts: string[]): URL {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error("Invalid repository URL"); }
  if (url.protocol !== "https:" || url.username || url.password || url.port && url.port !== "443" || !url.hostname || !url.pathname.endsWith(".git") || url.search || url.hash) {
    throw new Error("Repository origin is not permitted");
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  const approved = new Set(allowedHosts.map((host) => host.trim().toLowerCase().replace(/\.$/, "")).filter(Boolean));
  if (["api", "agent", "migrate", "postgres", "web"].includes(hostname) || !approved.has(hostname)) throw new Error("Repository origin is not permitted");
  url.hostname = hostname;
  return url;
}
async function defaultRepositoryResolver(hostname: string): Promise<string[]> {
  return (await lookup(hostname, { all: true })).map((record) => record.address);
}
function isForbiddenRepositoryAddress(address: string): boolean {
  const normalized = address.toLowerCase();
  const family = isIP(normalized);
  if (family === 4) return isForbiddenIpv4(normalized);
  if (family !== 6) return true;
  const mapped = normalized.match(/^(?:0{0,4}:){0,5}ffff:([0-9.]+)$/i);
  if (mapped) return isForbiddenIpv4(mapped[1]!);
  const expanded = expandIpv6(normalized);
  if (!expanded) return true;
  const first = Number.parseInt(expanded[0]!, 16);
  const second = Number.parseInt(expanded[1]!, 16);
  if (expanded.every((part) => part === "0000") || expanded.slice(0, 7).every((part) => part === "0000") && expanded[7] === "0001") return true;
  if ((first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00) return true;
  // Documentation, discard-only, and benchmark ranges are not public origins.
  return (first === 0x2001 && (second === 0x0db8 || second === 0x0002)) || (first === 0x0100 && second === 0x0000);
}
function isForbiddenIpv4(address: string): boolean {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return true;
  const a = octets[0]!;
  const b = octets[1]!;
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 0 || b === 168)) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
}
function expandIpv6(address: string): string[] | null {
  const [left, right] = address.split("::");
  if (address.split("::").length > 2) return null;
  const leftParts = left ? left.split(":") : [];
  const rightParts = right ? right.split(":") : [];
  if (leftParts.some((part) => !/^[0-9a-f]{1,4}$/i.test(part)) || rightParts.some((part) => !/^[0-9a-f]{1,4}$/i.test(part))) return null;
  const missing = 8 - leftParts.length - rightParts.length;
  if (missing < 0 || (address.includes("::") && missing < 1) || (!address.includes("::") && missing !== 0)) return null;
  return [...leftParts, ...Array(missing).fill("0"), ...rightParts].map((part) => part.padStart(4, "0"));
}
function managedRuntimeFromLine(line: string, projectSlug: string): { id: string; commandId: string } | null {
  const [id, name, managed, commandId, labelledProject, ...rest] = line.split("\t");
  if (rest.length || !id || !/^[a-f0-9]{12,64}$/i.test(id) || managed !== "true" || !commandId || !SAFE_ID.test(commandId) || labelledProject !== projectSlug) return null;
  try { return name === containerName(projectSlug, commandId) ? { id, commandId } : null; }
  catch { return null; }
}
function composeAbortSignals(parent: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; dispose(): void } {
  const deadline = AbortSignal.timeout(timeoutMs);
  if (!parent) return { signal: deadline, dispose: () => undefined };
  const controller = new AbortController();
  const abort = () => controller.abort();
  parent.addEventListener("abort", abort, { once: true });
  deadline.addEventListener("abort", abort, { once: true });
  if (parent.aborted || deadline.aborted) abort();
  return { signal: controller.signal, dispose: () => { parent.removeEventListener("abort", abort); deadline.removeEventListener("abort", abort); } };
}
function valueAfter(args: string[], option: string): string | undefined {
  const index = args.indexOf(option);
  return index === -1 ? undefined : args[index + 1];
}
function boundedHealthDuration(value: number | undefined, fallback: number, minimum = 1): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < minimum || value > 120_000) throw new Error("Invalid bounded health policy duration");
  return Math.floor(value);
}
function publicPlan(plan: CommandPlan): Record<string, unknown> { return { command: plan.command, args: plan.args.map(redact), cwd: plan.cwd ? "[REDACTED]" : undefined }; }
function render(plan: CommandPlan): string { return `${plan.command} ${plan.args.map(redact).join(" ")}`; }
function redact(value: string): string { return redactSecrets(value.replace(/https:\/\/[^\s/@]+(?::[^\s/@]*)?@/g, "https://[REDACTED]@")); }
function redactOutput(value: string): string {
  return redactEnvFileForLog(redact(value));
}
function errorMessage(error: unknown): string { return redactOutput(error instanceof Error ? error.message : "Deployment executor failed"); }

import {
  createRequestId,
  ENCRYPTION_KEY_VERSION,
  type EnvSecretCipher
} from "@deploylite/config";
import type {
  AgentStatusService,
  Deployment,
  DeploymentCommandBus,
  DeploymentCommandRecord,
  DeploymentExecutor,
  DeploymentRepository,
  EnvVariableMetadataRepository,
  Project
} from "@deploylite/domain";
import { materializeMockDeploy, redactEnvFileForLog, type EncryptedEnvRecord } from "@deploylite/domain";

/**
 * Deterministic set of mock env secret values used by the API's
 * dry-run materialization step. The values are intentionally harmless
 * (no real credentials) but they exercise the full encrypt -> decrypt
 * -> redact pipeline so the agent's `materializeMockDeploy` is
 * actually wired into the deploy path. The plaintext is held only for
 * the duration of the encrypt call and never written to a log or a
 * response; only the redacted projection reaches the deployment log.
 */
const DRY_RUN_MOCK_VALUES: ReadonlyArray<{ key: string; scope: "project" | "deployment"; value: string }> = [
  { key: "DATABASE_URL", scope: "project", value: "postgres://dry-run:placeholder@db.invalid:5432/dryrun" },
  { key: "API_KEY", scope: "project", value: "sk_dry_run_placeholder" }
];

export type DeploymentExecutorDeps = {
  bus: DeploymentCommandBus;
  deployments: DeploymentRepository;
  envMetadata: EnvVariableMetadataRepository;
  agentStatus: AgentStatusService;
  envSecretCipher?: EnvSecretCipher;
  projectResolver: (projectId: string) => Promise<Project | null>;
};

/**
 * In-process deployment executor. Mirrors the behaviour of the original
 * `DeployRunner` class in `apps/api/src/app.ts` so the slice-1 API
 * response and log surface are byte-for-byte identical. The executor
 * is the ONLY component allowed to mutate the deployment status, append
 * deployment logs, or touch the host. Slice 1 keeps the executor in
 * the API process for socket-free local development; a later slice
 * will mount the Docker socket on the agent container only and have
 * the executor run inside that process.
 */
export class MockDeploymentExecutor implements DeploymentExecutor {
  readonly #timers = new Map<string, NodeJS.Timeout>();
  readonly #bus: DeploymentCommandBus;
  readonly #deployments: DeploymentRepository;
  readonly #envMetadata: EnvVariableMetadataRepository;
  readonly #agentStatus: AgentStatusService;
  readonly #envSecretCipher: EnvSecretCipher | undefined;
  readonly #projectResolver: (projectId: string) => Promise<Project | null>;

  constructor(deps: DeploymentExecutorDeps) {
    this.#bus = deps.bus;
    this.#deployments = deps.deployments;
    this.#envMetadata = deps.envMetadata;
    this.#agentStatus = deps.agentStatus;
    this.#envSecretCipher = deps.envSecretCipher;
    this.#projectResolver = deps.projectResolver;
  }

  /**
   * Drive a single claimed `start` command through the existing mock
   * lifecycle. Cancel / restart / rollback commands are not yet
   * implemented at the executor layer; they will land in a later
   * slice alongside their API routes. The slice-1 contract is that an
   * unknown command kind resolves to a structured `fail` so the bus
   * can transition the row to a terminal state and the UI can show
   * the reason.
   */
  async execute(command: DeploymentCommandRecord): Promise<void> {
    const deployment = await this.#deployments.findById(command.deploymentId);
    if (!deployment) {
      await this.#bus.fail(command.id, "Deployment not found for command");
      return;
    }
    if (command.kind !== "start") {
      await this.#bus.fail(command.id, `Deployment executor for kind '${command.kind}' is not yet implemented (slice 1)`);
      return;
    }
    await this.#runStartCommand(command, deployment);
  }

  async #runStartCommand(command: DeploymentCommandRecord, deployment: Deployment): Promise<void> {
    const projectId = (command.payload["projectId"] as string | undefined) ?? null;
    if (!projectId) {
      await this.#failStart(command, deployment, "Project id is missing from the deployment command payload");
      return;
    }
    const project = await this.#projectResolver(projectId);
    if (!project) {
      await this.#failStart(command, deployment, "Project referenced by command is missing");
      return;
    }
    const logs = await this.#envMetadata.listByProject(project.id);
    const missingRequired = logs.filter((record) => record.required && !record.valuePresent);

    await this.#appendLog(deployment, "info", `Queued deploy for project ${project.name} (${project.repoUrl}@${project.defaultBranch}).`, command.requestId, command.correlationId);
    await this.#appendLog(deployment, "info", `Resolved ${logs.length} env metadata record(s); ${missingRequired.length} required-without-value.`, command.requestId, command.correlationId);

    if (missingRequired.length > 0) {
      await this.#failStart(command, deployment, `Refusing to advance: required env metadata missing for ${missingRequired.map((m) => m.key).join(", ")}.`);
      return;
    }

    const projection = await this.#materializeDryRun(project);
    if (projection) {
      await this.#appendLog(deployment, "info", `Materialized env (mock, redacted):\n${projection}`, command.requestId, command.correlationId);
    }

    if (!project.buildCommand) {
      await this.#appendLog(deployment, "warn", "No build command configured; skipping build step.", command.requestId, command.correlationId);
    } else {
      await this.#appendLog(deployment, "info", `Build command: ${project.buildCommand}`, command.requestId, command.correlationId);
    }
    if (!project.runCommand) {
      await this.#appendLog(deployment, "warn", "No run command configured; deploy will stay in queued state.", command.requestId, command.correlationId);
    } else {
      await this.#appendLog(deployment, "info", `Run command: ${project.runCommand} (port ${project.port ?? "default"})`, command.requestId, command.correlationId);
    }

    this.#scheduleAdvance(command.id, deployment.id, "running", 50, command.requestId, command.correlationId);
    // The lifecycle itself completes asynchronously via the timers.
    // The bus does not need to be resolved synchronously; a follow-up
    // call from the timer chain will resolve the command when the
    // deployment reaches the terminal state. The executor is
    // explicitly socket-free: no Docker, no shell, no host mutation.
  }

  async #failStart(command: DeploymentCommandRecord, deployment: Deployment, reason: string): Promise<void> {
    const failed: Deployment = { ...deployment, status: "failed", finishedAt: new Date().toISOString() };
    await this.#bus.projectTerminal(command.id, "failed", failed, deployment.status, {
      id: createRequestId(), deploymentId: deployment.id, level: "error", message: reason,
      timestamp: new Date().toISOString(), redactionApplied: true, requestId: command.requestId, correlationId: command.correlationId
    });
  }

  /**
   * Build a deterministic mock `EncryptedEnvRecord[]` and round-trip
   * it through the agent module's `materializeMockDeploy` +
   * `redactEnvFileForLog` pipeline. The output is the redacted
   * `.env` projection suitable for the deploy log; plaintext is
   * never returned. Returns null when no cipher is configured (so
   * the deploy can still proceed) or when the agent module refuses
   * to materialize (e.g. key version mismatch).
   */
  async #materializeDryRun(project: Project): Promise<string | null> {
    if (!this.#envSecretCipher) return null;
    try {
      const records: EncryptedEnvRecord[] = DRY_RUN_MOCK_VALUES.map((mock) => {
        const encryptedValue = Buffer.from(this.#envSecretCipher!.encrypt(mock.value), "base64");
        return {
          key: mock.key,
          scope: mock.scope,
          encryptedValue,
          valueFingerprint: this.#envSecretCipher!.fingerprint(mock.value),
          keyVersion: ENCRYPTION_KEY_VERSION
        };
      });
      const entry = materializeMockDeploy({
        projectId: project.id,
        agentId: "agent_dry_run",
        records,
        cipher: this.#envSecretCipher
      });
      return redactEnvFileForLog(entry.contents);
    } catch {
      return null;
    }
  }

  async #appendLog(deployment: Deployment, level: "debug" | "info" | "warn" | "error", message: string, requestId: string, correlationId: string): Promise<void> {
    await this.#deployments.appendAllocatedLog({
      id: createRequestId(),
      deploymentId: deployment.id,
      level,
      message,
      timestamp: new Date().toISOString(),
      redactionApplied: true,
      requestId,
      correlationId
    });
  }

  #scheduleAdvance(
    commandId: string,
    deploymentId: string,
    status: "running" | "succeeded" | "failed",
    delayMs: number,
    requestId: string,
    correlationId: string
  ): void {
    const previous = this.#timers.get(deploymentId);
    if (previous) {
      clearTimeout(previous);
    }
    const timer = setTimeout(async () => {
      this.#timers.delete(deploymentId);
      const existing = await this.#deployments.findById(deploymentId);
      if (!existing) return;
      if (existing.status === "failed" || existing.status === "succeeded" || existing.status === "canceled") return;
      const finishedAt = status === "running" ? null : new Date().toISOString();
      const next: Deployment = { ...existing, status, finishedAt };
      const message =
        status === "running"
          ? "Simulated agent picked up the deployment. Real Docker execution is intentionally deferred."
          : status === "succeeded"
            ? "Simulated agent marked the deployment succeeded. Real container execution is intentionally deferred."
            : "Simulated agent marked the deployment failed.";
      if (status === "running") {
        const authoritativeCommand = await this.#bus.findById(commandId);
        const authoritativeDeployment = await this.#deployments.findById(deploymentId);
        if (
          authoritativeCommand?.state !== "claimed" ||
          !authoritativeDeployment ||
          authoritativeDeployment.status === "failed" ||
          authoritativeDeployment.status === "succeeded" ||
          authoritativeDeployment.status === "canceled"
        ) return;
        const running = { ...authoritativeDeployment, status: "running" as const, finishedAt: null };
        const projected = await this.#deployments.saveWithLogIfStatus(running, authoritativeDeployment.status, {
          id: createRequestId(), deploymentId, level: "info", message,
          timestamp: new Date().toISOString(), redactionApplied: true, requestId, correlationId
        });
        if (!projected) return;
        this.#scheduleAdvance(commandId, deploymentId, "succeeded", 200, requestId, correlationId);
        return;
      }
      await this.#bus.projectTerminal(commandId, status === "succeeded" ? "completed" : "failed", next, existing.status, {
        id: createRequestId(), deploymentId, level: status === "succeeded" ? "info" : "error", message,
        timestamp: new Date().toISOString(), redactionApplied: true, requestId, correlationId
      });
      void this.#agentStatus;
    }, delayMs);
    this.#timers.set(deploymentId, timer);
  }

  cancelTimers(): void {
    for (const timer of this.#timers.values()) {
      clearTimeout(timer);
    }
    this.#timers.clear();
  }
}

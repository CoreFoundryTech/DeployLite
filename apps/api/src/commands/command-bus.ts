import { createRequestId, redactSecrets } from "@deploylite/config";
import type { Deployment, DeploymentCommandKind, DeploymentCommandState, LogEvent } from "@deploylite/contracts";
import {
  IllegalDeploymentCommandTransitionError,
  isDeploymentCommandTransitionAllowed,
  type DeploymentCommandBus,
  type DeploymentCommandBusSubmitInput,
  type DeploymentCommandEvent,
  type DeploymentCommandEventListener,
  type DeploymentCommandEventType,
  type DeploymentCommandRecord,
  type DeploymentCommandRepository,
  type DeploymentRepository,
  type DeploymentExecutor
} from "@deploylite/domain";
import { DEPLOYMENT_COMMAND_LEASE_MS } from "@deploylite/domain";

/**
 * Application-level deployment command bus.
 *
 * The bus is the in-process control-plane surface that the API uses to
 * publish deployment intent. It owns the deployment_commands persistence
 * and the lifecycle events that consumers (the in-process executor
 * today, the real agent in a later slice) subscribe to. The bus itself
 * never touches the host, the Docker socket, or any privileged API:
 * the only side effects are the repository writes and the synchronous
 * event fan-out to registered listeners.
 *
 * State machine (enforced both at the application boundary and at the
 * database CHECK constraints, see `0005_deployment_commands.sql`):
 *   pending  -> claimed   -> completed
 *                        -> failed
 *           -> cancelled
 *   claimed  -> cancelled (handled by the executor mid-flight)
 *
 * Each transition emits a `DeploymentCommandEvent`. The executor is
 * registered with the bus and is responsible for claiming the command
 * (`bus.claim`) before doing any work, and for resolving the command
 * (`bus.complete` / `bus.fail` / `bus.cancel`) when it finishes.
 */
export class DeploymentCommandBusService implements DeploymentCommandBus {
  readonly #repository: DeploymentCommandRepository;
  readonly #listeners = new Set<DeploymentCommandEventListener>();
  #executor: DeploymentExecutor | null = null;

  constructor(repository: DeploymentCommandRepository, private readonly now: () => Date = () => new Date(), private readonly deployments?: DeploymentRepository) {
    this.#repository = repository;
  }

  /**
   * Register the executor that will handle claimed commands. The bus
   * dispatches events to the executor exactly once per event; the
   * executor decides whether to claim the command. Registering an
   * executor is idempotent and replaces any previous registration.
   */
  registerExecutor(executor: DeploymentExecutor): void {
    this.#executor = executor;
  }

  async submit(input: DeploymentCommandBusSubmitInput): Promise<DeploymentCommandRecord> {
    if (!isSupportedKind(input.kind)) {
      throw new Error(`Unsupported deployment command kind: ${input.kind}`);
    }
    const issuedAt = new Date().toISOString();
    const command: DeploymentCommandRecord = {
      id: createRequestId(),
      deploymentId: input.deploymentId,
      agentId: input.agentId,
      kind: input.kind,
      state: "pending",
      payload: input.payload ?? {},
      requestedBy: input.requestedBy,
      requestId: input.requestId,
      correlationId: input.correlationId,
      issuedAt,
      claimedAt: null,
      leaseExpiresAt: null,
      completedAt: null,
      failureReason: null
    };
    const saved = await this.#repository.save(command);
    await this.#emit("deployment.command.submitted", saved);
    return saved;
  }

  async claim(commandId: string, agentId: string): Promise<DeploymentCommandRecord | null> {
    const existing = await this.#repository.findById(commandId);
    if (!existing) return null;
    if (existing.agentId !== agentId) {
      // The command is reserved for a different agent. Refuse the claim
      // rather than silently mutating it; this is the boundary that will
      // protect the real agent from a misrouted claim.
      return null;
    }
    if (existing.state === "claimed") return existing;
    if (!isDeploymentCommandTransitionAllowed(existing.state, "claimed")) {
      return null;
    }
    const now = this.now();
    const claimedAt = now.toISOString();
    const saved = await this.#repository.claim(existing.id, agentId, claimedAt, new Date(now.getTime() + DEPLOYMENT_COMMAND_LEASE_MS).toISOString());
    if (!saved) return null;
    await this.#emit("deployment.command.claimed", saved);
    return saved;
  }

  async renewLease(commandId: string, agentId: string): Promise<DeploymentCommandRecord | null> {
    const now = this.now();
    return this.#repository.renewLease(commandId, agentId, now.toISOString(), new Date(now.getTime() + DEPLOYMENT_COMMAND_LEASE_MS).toISOString());
  }

  async complete(commandId: string, output?: Record<string, unknown>): Promise<DeploymentCommandRecord | null> {
    const existing = await this.#repository.findById(commandId);
    if (!existing) return null;
    if (existing.state === "completed" || existing.state === "failed" || existing.state === "cancelled") return existing;
    if (!isDeploymentCommandTransitionAllowed(existing.state, "completed")) {
      throw new IllegalDeploymentCommandTransitionError(existing.state, "completed", commandId);
    }
    const next: DeploymentCommandRecord = {
      ...existing,
      state: "completed",
      completedAt: this.now().toISOString(),
      leaseExpiresAt: null,
      payload: output ? { ...existing.payload, output } : existing.payload
    };
    const result = await this.#repository.transitionTerminal(existing.id, existing.agentId, "claimed", next, {
      leaseExpiresAtAfterNow: () => this.now().toISOString()
    });
    if (result && !result.applied && result.command.state === "claimed") {
      return this.failExpiredClaim(commandId, "Agent command lease expired; completion was rejected.");
    }
    if (result?.applied) await this.#emit("deployment.command.completed", result.command);
    return result?.command ?? null;
  }

  async fail(commandId: string, reason: string): Promise<DeploymentCommandRecord | null> {
    const existing = await this.#repository.findById(commandId);
    if (!existing) return null;
    if (existing.state === "completed" || existing.state === "failed" || existing.state === "cancelled") return existing;
    if (!isDeploymentCommandTransitionAllowed(existing.state, "failed")) {
      throw new IllegalDeploymentCommandTransitionError(existing.state, "failed", commandId);
    }
    const next: DeploymentCommandRecord = {
      ...existing,
      state: "failed",
      completedAt: this.now().toISOString(),
      leaseExpiresAt: null,
      failureReason: reason
    };
    const result = await this.#repository.transitionTerminal(existing.id, existing.agentId, "claimed", next, {
      leaseExpiresAtAfterNow: () => this.now().toISOString()
    });
    if (result?.applied) await this.#emit("deployment.command.failed", result.command);
    return result?.command ?? null;
  }

  async failSystem(commandId: string, reason: string): Promise<DeploymentCommandRecord | null> {
    const existing = await this.#repository.findById(commandId);
    if (!existing) return null;
    if (existing.state === "completed" || existing.state === "failed" || existing.state === "cancelled") return existing;
    const next: DeploymentCommandRecord = {
      ...existing,
      state: "failed",
      completedAt: this.now().toISOString(),
      leaseExpiresAt: null,
      failureReason: reason
    };
    let result = await this.#repository.transitionTerminal(existing.id, existing.agentId, existing.state, next);
    if (result && !result.applied && (result.command.state === "pending" || result.command.state === "claimed")) {
      const authoritativeNext: DeploymentCommandRecord = {
        ...result.command,
        state: "failed",
        completedAt: this.now().toISOString(),
        leaseExpiresAt: null,
        failureReason: reason
      };
      result = await this.#repository.transitionTerminal(result.command.id, result.command.agentId, result.command.state, authoritativeNext);
    }
    if (result?.applied) await this.#emit("deployment.command.failed", result.command);
    return result?.command ?? null;
  }

  async failExpiredClaim(commandId: string, reason: string): Promise<DeploymentCommandRecord | null> {
    const existing = await this.#repository.findById(commandId);
    if (!existing) return null;
    if (existing.state === "completed" || existing.state === "failed" || existing.state === "cancelled") return existing;
    if (existing.state !== "claimed") return existing;
    const now = this.now().toISOString();
    const next: DeploymentCommandRecord = {
      ...existing,
      state: "failed",
      completedAt: now,
      leaseExpiresAt: null,
      failureReason: reason
    };
    const result = await this.#repository.transitionTerminal(existing.id, existing.agentId, "claimed", next, {
      leaseExpiresAtNotAfterNow: () => this.now().toISOString()
    });
    if (result?.applied) await this.#emit("deployment.command.failed", result.command);
    return result?.command ?? null;
  }

  async cancel(commandId: string, requestedBy: string | null): Promise<DeploymentCommandRecord | null> {
    const existing = await this.#repository.findById(commandId);
    if (!existing) return null;
    if (!isDeploymentCommandTransitionAllowed(existing.state, "cancelled")) {
      // The command is already in a terminal state. Cancelling an
      // already-finished command is a no-op and returns the existing
      // row so the caller can treat the request as idempotent.
      return existing;
    }
    if (existing.state !== "pending" && existing.state !== "claimed") return existing;
    const next: DeploymentCommandRecord = {
      ...existing,
      state: "cancelled",
      completedAt: this.now().toISOString(),
      leaseExpiresAt: null,
      payload: requestedBy ? { ...existing.payload, cancelledBy: redactSecrets(requestedBy) } : existing.payload
    };
    const result = await this.#repository.transitionTerminal(existing.id, existing.agentId, existing.state, next);
    if (result?.applied) await this.#emit("deployment.command.cancelled", result.command);
    return result?.command ?? null;
  }

  async projectRunning(commandId: string, deployment: Deployment, expectedStatus: Deployment["status"], event: Omit<LogEvent, "sequence">, deployments: DeploymentRepository): Promise<DeploymentCommandRecord | null> { const command = await this.#repository.findById(commandId); if (!command || !this.#repository.projectRunning) return null; const result = await this.#repository.projectRunning(commandId, command.agentId, deployment, expectedStatus, event, this.deployments ?? deployments); return result?.applied ? result.command : null; }

  async projectTerminal(commandId: string, state: "completed" | "failed", deployment: Deployment, expectedStatus: Deployment["status"], event: Omit<LogEvent, "sequence">): Promise<DeploymentCommandRecord | null> {
    const command = await this.#repository.findById(commandId);
    if (!command || !this.deployments) return command;
    const result = await this.#repository.projectTerminal(commandId, command.agentId, state, deployment, expectedStatus, event, this.deployments);
    if (result?.applied) await this.#emit(`deployment.command.${state}` as DeploymentCommandEventType, result.command);
    return result?.command ?? null;
  }

  async list(): Promise<DeploymentCommandRecord[]> {
    return this.#repository.list();
  }

  async findById(commandId: string): Promise<DeploymentCommandRecord | null> {
    return this.#repository.findById(commandId);
  }

  async findActiveForDeployment(deploymentId: string): Promise<DeploymentCommandRecord | null> {
    return this.#repository.findActiveForDeployment(deploymentId);
  }

  onEvent(listener: DeploymentCommandEventListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /**
   * Drive a single submitted command to completion through the
   * registered executor. Used by the in-process `MockDeploymentExecutor`
   * path; the real agent will replace this with a long-poll / SSE
   * flow in a later slice. Returns the resolved command.
   */
  async dispatch(command: DeploymentCommandRecord): Promise<DeploymentCommandRecord | null> {
    if (!this.#executor) {
      return null;
    }
    const claimed = await this.claim(command.id, command.agentId);
    if (!claimed) {
      return null;
    }
    try {
      await this.#executor.execute(claimed);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Deployment executor failed";
      await this.fail(claimed.id, reason);
      throw error;
    }
    // The executor is responsible for resolving the command (complete /
    // fail / cancel). It may also do so asynchronously; this dispatch
    // helper returns the claimed row so the caller can observe the
    // initial state transition.
    return claimed;
  }

  async #emit(type: DeploymentCommandEventType, command: DeploymentCommandRecord): Promise<void> {
    const event: DeploymentCommandEvent = {
      type,
      command: redactCommand(command),
      occurredAt: new Date().toISOString()
    };
    for (const listener of this.#listeners) {
      try {
        await listener(event);
      } catch (error) {
        // The bus must never let a listener failure poison the
        // command state. The executor is expected to be idempotent
        // and to handle its own retries; the bus only records the
        // surface error so it can be surfaced from the API process.
        if (typeof console !== "undefined" && typeof console.error === "function") {
          console.error(`[deployment-command-bus] listener failed for ${type} ${command.id}:`, error);
        }
      }
    }
  }
}

function isSupportedKind(kind: DeploymentCommandKind): boolean {
  return kind === "start" || kind === "cancel" || kind === "restart" || kind === "rollback";
}

function redactCommand(command: DeploymentCommandRecord): DeploymentCommandRecord {
  return {
    ...command,
    payload: redactSecrets(command.payload) as Record<string, unknown>
  };
}

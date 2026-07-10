import { createRequestId, redactSecrets } from "@deploylite/config";
import type { DeploymentCommandKind, DeploymentCommandState } from "@deploylite/contracts";
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
  type DeploymentExecutor
} from "@deploylite/domain";

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

  constructor(repository: DeploymentCommandRepository) {
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
    if (!isDeploymentCommandTransitionAllowed(existing.state, "claimed")) {
      return null;
    }
    const next: DeploymentCommandRecord = {
      ...existing,
      state: "claimed",
      claimedAt: existing.claimedAt ?? new Date().toISOString()
    };
    const saved = await this.#repository.save(next);
    await this.#emit("deployment.command.claimed", saved);
    return saved;
  }

  async complete(commandId: string, output?: Record<string, unknown>): Promise<DeploymentCommandRecord | null> {
    const existing = await this.#repository.findById(commandId);
    if (!existing) return null;
    if (!isDeploymentCommandTransitionAllowed(existing.state, "completed")) {
      throw new IllegalDeploymentCommandTransitionError(existing.state, "completed", commandId);
    }
    const next: DeploymentCommandRecord = {
      ...existing,
      state: "completed",
      completedAt: new Date().toISOString(),
      payload: output ? { ...existing.payload, output } : existing.payload
    };
    const saved = await this.#repository.save(next);
    await this.#emit("deployment.command.completed", saved);
    return saved;
  }

  async fail(commandId: string, reason: string): Promise<DeploymentCommandRecord | null> {
    const existing = await this.#repository.findById(commandId);
    if (!existing) return null;
    if (!isDeploymentCommandTransitionAllowed(existing.state, "failed")) {
      throw new IllegalDeploymentCommandTransitionError(existing.state, "failed", commandId);
    }
    const next: DeploymentCommandRecord = {
      ...existing,
      state: "failed",
      completedAt: new Date().toISOString(),
      failureReason: reason
    };
    const saved = await this.#repository.save(next);
    await this.#emit("deployment.command.failed", saved);
    return saved;
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
    const next: DeploymentCommandRecord = {
      ...existing,
      state: "cancelled",
      completedAt: new Date().toISOString(),
      payload: requestedBy ? { ...existing.payload, cancelledBy: requestedBy } : existing.payload
    };
    const saved = await this.#repository.save(next);
    await this.#emit("deployment.command.cancelled", saved);
    return saved;
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

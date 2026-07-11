import { agentSchema, deploymentCommandSchema, resourceSnapshotSchema, type Agent, type DeploymentCommand } from "@deploylite/contracts";
import { z } from "zod";
import { DEPLOYMENT_COMMAND_LEASE_RENEWAL_MS } from "@deploylite/domain";
import type { CommandBusClient, DeploymentExecutionInput, DeploymentExecutionResult, ExecutorLogger } from "./executor/index.js";
import { redactEnvFileForLog } from "./redaction.js";
import type { AgentReadiness } from "./readiness.js";

const executionInputSchema = z.object({
  command: deploymentCommandSchema,
  repoUrl: z.string().min(1),
  ref: z.string().min(1),
  projectSlug: z.string().min(1),
  envFile: z.object({ contents: z.string() }),
  healthUrl: z.string().url(),
  dryRun: z.boolean().optional()
});

const terminalConflictResponseSchema = z.object({
  data: z.object({
    authoritativeCommand: deploymentCommandSchema,
    attemptedState: z.enum(["completed", "failed"]),
    leaseConflict: z.literal(true).optional()
  }),
  error: z.object({ code: z.enum(["AUTHORITATIVE_TERMINAL_CONFLICT", "AUTHORITATIVE_LEASE_CONFLICT"]) })
}).passthrough();

export class AuthoritativeTerminalConflictError extends Error {
  constructor(
    public readonly authoritativeCommand: DeploymentCommand,
    public readonly attemptedState: "completed" | "failed",
    public readonly leaseConflict = false
  ) {
    super("Agent command has a different authoritative terminal outcome");
    this.name = "AuthoritativeTerminalConflictError";
  }
}

export class AgentRequestTimeoutError extends Error {
  constructor() {
    super("Agent API request timed out");
    this.name = "AgentRequestTimeoutError";
  }
}

export type AgentCommandTransport = CommandBusClient & {
  register(input: AgentRegistrationInput, signal: AbortSignal): Promise<Agent>;
  heartbeat(agentId: string, observedAt: string, resourceSnapshot: ResourceSnapshot, signal: AbortSignal): Promise<Agent>;
  poll(agentId: string, signal: AbortSignal): Promise<DeploymentExecutionInput | null>;
  recoverClaimed(agentId: string, signal: AbortSignal): Promise<DeploymentExecutionInput | null>;
};

export type ResourceSnapshot = z.infer<typeof resourceSnapshotSchema>;
export type ResourceSnapshotCollector = { collect(): Promise<ResourceSnapshot> };
export type AgentRegistrationInput = { agentId: string; name: string; endpoint: string; observedAt: string; resourceSnapshot: ResourceSnapshot };
export type TerminalAcknowledgementReplayer = { replayPending(): Promise<boolean> };

export type DeploymentExecutorPort = {
  execute(input: DeploymentExecutionInput, signal?: AbortSignal): Promise<DeploymentExecutionResult>;
  reconcile(input: DeploymentExecutionInput): Promise<DeploymentExecutionResult>;
  reconcilePending?(signal?: AbortSignal): Promise<boolean>;
};

export type AgentWorkerOptions = {
  agentId: string;
  agentName: string;
  agentEndpoint: string;
  transport: AgentCommandTransport;
  executor: DeploymentExecutorPort;
  resourceCollector: ResourceSnapshotCollector;
  terminalAcks?: TerminalAcknowledgementReplayer;
  logger?: ExecutorLogger;
  retryDelayMs?: number;
  heartbeatIntervalMs?: number;
  maxHeartbeatBackoffMs?: number;
  cleanupRepairIntervalMs?: number;
  leaseRenewalIntervalMs?: number;
  now?: () => Date;
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  readiness?: AgentReadiness;
};

export class AgentWorker {
  readonly #logger: ExecutorLogger;
  readonly #retryDelayMs: number;
  readonly #wait: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  readonly #heartbeatIntervalMs: number;
  readonly #maxHeartbeatBackoffMs: number;
  readonly #now: () => Date;
  readonly #leaseRenewalIntervalMs: number;
  readonly #cleanupRepairIntervalMs: number;

  constructor(private readonly options: AgentWorkerOptions) {
    this.#logger = options.logger ?? { log: () => undefined };
    this.#retryDelayMs = options.retryDelayMs ?? 1_000;
    this.#wait = options.wait ?? abortableWait;
    this.#heartbeatIntervalMs = Math.min(60_000, Math.max(5_000, options.heartbeatIntervalMs ?? 15_000));
    this.#maxHeartbeatBackoffMs = Math.min(60_000, Math.max(this.#retryDelayMs, options.maxHeartbeatBackoffMs ?? 30_000));
    this.#now = options.now ?? (() => new Date());
    this.#leaseRenewalIntervalMs = Math.max(1, options.leaseRenewalIntervalMs ?? DEPLOYMENT_COMMAND_LEASE_RENEWAL_MS);
    this.#cleanupRepairIntervalMs = Math.min(60_000, Math.max(this.#retryDelayMs, options.cleanupRepairIntervalMs ?? 15_000));
  }

  async run(signal: AbortSignal): Promise<void> {
    await this.options.readiness?.clear();
    try {
      const initialSnapshot = resourceSnapshotSchema.parse(await this.options.resourceCollector.collect());
      const registered = await this.options.transport.register({
        agentId: this.options.agentId,
        name: this.options.agentName,
        endpoint: this.options.agentEndpoint,
        observedAt: this.#now().toISOString(),
        resourceSnapshot: initialSnapshot
      }, signal);
      if (registered.id !== this.options.agentId) throw new Error("Agent registration identity mismatch");
      await Promise.all([this.pollLoop(signal), this.heartbeatLoop(signal), this.cleanupRepairLoop(signal)]);
    } finally {
      await this.options.readiness?.clear();
    }
  }

  private async pollLoop(signal: AbortSignal): Promise<void> {
    let terminalRetryMs = this.#retryDelayMs;
    let startupReconciled = false;
    while (!signal.aborted) {
      try {
        if (this.options.terminalAcks && !(await this.options.terminalAcks.replayPending())) {
          await this.safeLog("error", "Terminal acknowledgement retry failed");
          await this.#wait(terminalRetryMs, signal);
          terminalRetryMs = Math.min(this.#maxHeartbeatBackoffMs, Math.max(this.#retryDelayMs, terminalRetryMs * 2));
          continue;
        }
        terminalRetryMs = this.#retryDelayMs;
        if (!startupReconciled) {
          const claimed = await this.options.transport.recoverClaimed(this.options.agentId, signal);
          if (claimed) await this.options.executor.reconcile(claimed);
          startupReconciled = true;
        }
        const input = await this.options.transport.poll(this.options.agentId, signal);
        if (signal.aborted) break;
        await this.options.readiness?.markReady();
        if (!input) {
          await this.#wait(this.#retryDelayMs, signal);
          continue;
        }
        if (input.command.agentId !== this.options.agentId) {
          await this.safeLog("error", "Transport returned a command assigned to another agent");
          await this.#wait(this.#retryDelayMs, signal);
          continue;
        }
        await this.executeWithLease(input, signal);
      } catch (error) {
        if (signal.aborted) break;
        await this.safeLog("error", `Agent poll failed: ${safeError(error)}`);
        await this.#wait(this.#retryDelayMs, signal);
      }
    }
  }

  /** Kept separate from polling: Docker repair I/O must never delay command delivery. */
  private async cleanupRepairLoop(signal: AbortSignal): Promise<void> {
    if (!this.options.executor.reconcilePending) return;
    let retryMs = this.#retryDelayMs;
    while (!signal.aborted) {
      try {
        const result = await stopOnAbort(this.options.executor.reconcilePending(signal), signal);
        if (result.aborted) break;
        const complete = result.value!;
        if (complete) {
          retryMs = this.#retryDelayMs;
          await this.#wait(this.#cleanupRepairIntervalMs, signal);
        } else {
          await this.safeLog("error", "Managed resource cleanup remains incomplete; repair will retry");
          await this.#wait(retryMs, signal);
          retryMs = Math.min(this.#maxHeartbeatBackoffMs, Math.max(this.#retryDelayMs, retryMs * 2));
        }
      } catch {
        if (signal.aborted) break;
        await this.safeLog("error", "Managed resource cleanup repair reconciliation failed; repair will retry");
        await this.#wait(retryMs, signal);
        retryMs = Math.min(this.#maxHeartbeatBackoffMs, Math.max(this.#retryDelayMs, retryMs * 2));
      }
    }
  }

  private async executeWithLease(input: DeploymentExecutionInput, parentSignal: AbortSignal): Promise<void> {
    if (input.command.state !== "claimed" || !input.command.leaseExpiresAt) throw new Error("Polled command was not leased");
    const execution = new AbortController();
    const stop = () => execution.abort();
    parentSignal.addEventListener("abort", stop, { once: true });
    let finished = false;
    const execute = this.options.executor.execute(input, execution.signal).finally(() => {
      finished = true;
      execution.abort();
    });
    const renew = (async () => {
      while (!finished && !execution.signal.aborted) {
        await this.#wait(this.#leaseRenewalIntervalMs, execution.signal);
        if (finished || execution.signal.aborted) break;
        try {
          const command = await this.options.transport.renewLease(input.command.id, this.options.agentId);
          if (!command || command.id !== input.command.id || command.agentId !== this.options.agentId || command.state !== "claimed" || !command.leaseExpiresAt) {
            throw new Error("Command lease renewal was not confirmed");
          }
        } catch {
          execution.abort();
          break;
        }
      }
    })();
    try { await Promise.all([execute, renew]); }
    finally { parentSignal.removeEventListener("abort", stop); }
  }

  private async heartbeatLoop(signal: AbortSignal): Promise<void> {
    let retryMs = this.#retryDelayMs;
    while (!signal.aborted) {
      await this.#wait(this.#heartbeatIntervalMs, signal);
      if (signal.aborted) break;
      try {
        const snapshot = resourceSnapshotSchema.parse(await this.options.resourceCollector.collect());
        const agent = await this.options.transport.heartbeat(this.options.agentId, this.#now().toISOString(), snapshot, signal);
        if (agent.id !== this.options.agentId) throw new Error("Agent heartbeat identity mismatch");
        retryMs = this.#retryDelayMs;
      } catch (error) {
        if (signal.aborted) break;
        await this.safeLog("error", `Agent heartbeat failed: ${safeError(error)}`);
        await this.#wait(retryMs, signal);
        retryMs = Math.min(this.#maxHeartbeatBackoffMs, Math.max(this.#retryDelayMs, retryMs * 2));
      }
    }
  }

  private async safeLog(level: "info" | "error", message: string): Promise<void> {
    try { await this.#logger.log(level, redactEnvFileForLog(message)); } catch { /* logging cannot stop the worker */ }
  }
}

export type HttpAgentTransportOptions = {
  apiUrl: string;
  token: string;
  fetch?: typeof fetch;
  requestTimeoutMs?: number;
  setTimeout?: (callback: () => void, milliseconds: number) => ReturnType<typeof setTimeout>;
  clearTimeout?: (timeout: ReturnType<typeof setTimeout>) => void;
};

/** HTTP-only adapter. It uses fixed same-origin paths and never evaluates API output. */
export class HttpAgentCommandTransport implements AgentCommandTransport {
  readonly #baseUrl: URL;
  readonly #fetch: typeof fetch;
  readonly #requestTimeoutMs: number;
  readonly #setTimeout: (callback: () => void, milliseconds: number) => ReturnType<typeof setTimeout>;
  readonly #clearTimeout: (timeout: ReturnType<typeof setTimeout>) => void;

  constructor(private readonly options: HttpAgentTransportOptions) {
    this.#baseUrl = new URL(options.apiUrl);
    if (!/^https?:$/.test(this.#baseUrl.protocol)) throw new Error("Agent API URL must use HTTP or HTTPS");
    if (!options.token) throw new Error("Agent API token is required");
    this.#fetch = options.fetch ?? fetch;
    this.#requestTimeoutMs = Math.min(60_000, Math.max(1_000, options.requestTimeoutMs ?? 10_000));
    this.#setTimeout = options.setTimeout ?? setTimeout;
    this.#clearTimeout = options.clearTimeout ?? clearTimeout;
  }

  async register(input: AgentRegistrationInput, signal: AbortSignal): Promise<Agent> {
    const result = await this.request("/api/v1/agent/register", {
      method: "POST", signal, headers: { "content-type": "application/json" }, body: JSON.stringify(input)
    });
    return agentSchema.parse(result);
  }

  async heartbeat(agentId: string, observedAt: string, resourceSnapshot: ResourceSnapshot, signal: AbortSignal): Promise<Agent> {
    const result = await this.request(`/api/v1/agent/${encodeURIComponent(agentId)}/heartbeat`, {
      method: "POST", signal, headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentId, observedAt, resourceSnapshot: resourceSnapshotSchema.parse(resourceSnapshot) })
    });
    return agentSchema.parse(result);
  }

  async poll(agentId: string, signal: AbortSignal): Promise<DeploymentExecutionInput | null> {
    const result = await this.request(`/api/v1/agent/commands/next?agentId=${encodeURIComponent(agentId)}`, { method: "GET", signal });
    if (result === null) return null;
    return executionInputSchema.parse(result);
  }

  async recoverClaimed(agentId: string, signal: AbortSignal): Promise<DeploymentExecutionInput | null> {
    const result = await this.request(`/api/v1/agent/commands/claimed?agentId=${encodeURIComponent(agentId)}`, { method: "GET", signal });
    if (result === null) return null;
    return executionInputSchema.parse(result);
  }

  async claim(commandId: string, agentId: string): Promise<DeploymentCommand | null> {
    return this.commandRequest(commandId, "claim", { agentId });
  }

  async complete(commandId: string, output?: Record<string, unknown>): Promise<DeploymentCommand | null> {
    return this.commandRequest(commandId, "complete", { output });
  }

  async fail(commandId: string, reason: string): Promise<DeploymentCommand | null> {
    return this.commandRequest(commandId, "fail", { reason: redactEnvFileForLog(reason) });
  }

  async renewLease(commandId: string, agentId: string): Promise<DeploymentCommand | null> {
    return this.commandRequest(commandId, "renew", { agentId });
  }

  private async commandRequest(commandId: string, action: string, body: Record<string, unknown>): Promise<DeploymentCommand | null> {
    const result = await this.request(`/api/v1/agent/commands/${encodeURIComponent(commandId)}/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    return result === null ? null : deploymentCommandSchema.parse(result);
  }

  private async request(path: string, init: RequestInit): Promise<unknown | null> {
    const url = new URL(path, this.#baseUrl);
    if (url.origin !== this.#baseUrl.origin) throw new Error("Agent transport refused a cross-origin request");
    const controller = new AbortController();
    let timedOut = false;
    const abort = () => controller.abort();
    init.signal?.addEventListener("abort", abort, { once: true });
    if (init.signal?.aborted) abort();
    const timeout = this.#setTimeout(() => { timedOut = true; controller.abort(); }, this.#requestTimeoutMs);
    try {
      const response = await this.#fetch(url, {
        ...init,
        signal: controller.signal,
        headers: { ...init.headers, authorization: `Bearer ${this.options.token}` }
      });
      if (response.status === 204) return null;
      if (response.status === 409) {
        const parsed = terminalConflictResponseSchema.safeParse(await response.json());
        if (parsed.success) throw new AuthoritativeTerminalConflictError(parsed.data.data.authoritativeCommand, parsed.data.data.attemptedState, parsed.data.data.leaseConflict === true);
        throw new Error("Agent API returned an invalid terminal conflict response");
      }
      if (!response.ok) throw new Error(`Agent API request failed with status ${response.status}`);
      return await response.json();
    } catch (error) {
      if (timedOut) throw new AgentRequestTimeoutError();
      throw error;
    } finally {
      this.#clearTimeout(timeout);
      init.signal?.removeEventListener("abort", abort);
    }
  }
}

function safeError(error: unknown): string {
  return redactEnvFileForLog(error instanceof Error ? error.message : "Unknown transport error");
}

function abortableWait(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolveWait) => {
    if (signal.aborted) return resolveWait();
    const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); resolveWait(); };
    const abort = () => finish();
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener("abort", abort, { once: true });
  });
}

function stopOnAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<{ aborted: true } | { aborted: false; value: T }> {
  if (signal.aborted) return Promise.resolve({ aborted: true });
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); resolve({ aborted: true }); };
    signal.addEventListener("abort", abort, { once: true });
    operation.then(
      (value) => { signal.removeEventListener("abort", abort); resolve({ aborted: false, value }); },
      (error) => { signal.removeEventListener("abort", abort); reject(error); }
    ).finally(() => signal.removeEventListener("abort", abort));
  });
}

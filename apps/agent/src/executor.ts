import { redactSecrets } from "@deploylite/config";
import {
  runtimeActivationCommandSchema,
  runtimeActivationSchema,
  type RuntimeActivation,
  type RuntimeActivationCommand
} from "@deploylite/contracts";
import { redactEnvFileForLog } from "./index.js";

export type ControlledRuntimePlan = {
  commandId: string;
  projectId: string;
  configurationRef: string;
  domain: string;
  composeProfile: "runtime";
  action: "apply";
  traefik: { exposure: "internal-only"; publicPorts: [] };
};

export type RuntimeCommandRunner = {
  run(plan: ControlledRuntimePlan, options: { timeoutMs: number; signal: AbortSignal }): Promise<{ output: string }>;
  rollback(plan: ControlledRuntimePlan, options: { timeoutMs: number; signal: AbortSignal }): Promise<{ output: string }>;
};

export type SafeRuntimeExecutorCapability = {
  available: boolean;
  runner?: RuntimeCommandRunner;
  timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 30_000;

class RuntimeOperationTimeoutError extends Error {}

function withTimeout<T>(operation: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  return Promise.race([
    operation(controller.signal),
    new Promise<never>((_, reject) => controller.signal.addEventListener("abort", () => reject(new RuntimeOperationTimeoutError()), { once: true }))
  ]).finally(() => clearTimeout(timeout));
}

export function renderControlledRuntimePlan(input: RuntimeActivationCommand): ControlledRuntimePlan {
  const command = runtimeActivationCommandSchema.parse(input);
  return {
    commandId: command.commandId,
    projectId: command.projectId,
    configurationRef: command.configurationRef,
    domain: command.domain,
    composeProfile: "runtime",
    action: "apply",
    traefik: { exposure: "internal-only", publicPorts: [] }
  };
}

export function redactRuntimeOutput(output: string): string {
  return redactSecrets(redactEnvFileForLog(output))
    .replace(/\b(password|secret|token|authorization)\s*[:=]\s*\S+/gi, "$1=[REDACTED]")
    .replace(/:\/\/[^\s/:]+:[^\s@]+@/g, "://[REDACTED]@");
}

export class SafeRuntimeExecutor {
  readonly #results = new Map<string, RuntimeActivation>();
  readonly #executions = new Map<string, Promise<RuntimeActivation>>();

  constructor(private readonly capability: SafeRuntimeExecutorCapability) {}

  async execute(input: RuntimeActivationCommand): Promise<RuntimeActivation> {
    const command = runtimeActivationCommandSchema.parse(input);
    const cached = this.#results.get(command.idempotencyKey);
    if (cached) return cached;
    const inFlight = this.#executions.get(command.idempotencyKey);
    if (inFlight) return inFlight;
    const execution = this.executeOnce(command);
    this.#executions.set(command.idempotencyKey, execution);
    try {
      return await execution;
    } finally {
      this.#executions.delete(command.idempotencyKey);
    }
  }

  private async executeOnce(command: RuntimeActivationCommand): Promise<RuntimeActivation> {
    if (!this.capability.available || !this.capability.runner) {
      return this.remember(command, "capability_unavailable", null);
    }

    const plan = renderControlledRuntimePlan(command);
    const timeoutMs = this.capability.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    try {
      const result = await withTimeout((signal) => this.capability.runner!.run(plan, { timeoutMs, signal }), timeoutMs);
      return this.remember(command, "succeeded", redactRuntimeOutput(result.output));
    } catch (error) {
      const reason = error instanceof RuntimeOperationTimeoutError ? "Runtime execution timed out." : "Runtime execution failed.";
      try {
        const rollback = await withTimeout((signal) => this.capability.runner!.rollback(plan, { timeoutMs, signal }), timeoutMs);
        return this.remember(command, "failed", `${reason} Rollback: ${redactRuntimeOutput(rollback.output)}`);
      } catch (rollbackError) {
        return this.remember(command, "failed", `${reason} ${rollbackError instanceof RuntimeOperationTimeoutError ? "Rollback timed out." : "Rollback failed."}`);
      }
    }
  }

  private remember(command: RuntimeActivationCommand, status: RuntimeActivation["status"], output: string | null): RuntimeActivation {
    const result = runtimeActivationSchema.parse({
      id: command.idempotencyKey,
      commandId: command.commandId,
      status,
      capability: "safe_runtime_executor",
      output
    });
    this.#results.set(command.idempotencyKey, result);
    return result;
  }
}

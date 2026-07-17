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
  rollback(plan: ControlledRuntimePlan): Promise<{ output: string }>;
};

export type SafeRuntimeExecutorCapability = {
  available: boolean;
  runner?: RuntimeCommandRunner;
  timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 30_000;

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
    const controller = new AbortController();
    const timeoutMs = this.capability.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    try {
      const result = await Promise.race([
        this.capability.runner.run(plan, { timeoutMs, signal: controller.signal }),
        new Promise<never>((_, reject) => controller.signal.addEventListener("abort", () => reject(new Error("runtime execution timed out")), { once: true }))
      ]);
      return this.remember(command, "succeeded", redactRuntimeOutput(result.output));
    } catch (error) {
      const reason = timedOut ? "Runtime execution timed out." : "Runtime execution failed.";
      try {
        const rollback = await this.capability.runner.rollback(plan);
        return this.remember(command, "failed", `${reason} Rollback: ${redactRuntimeOutput(rollback.output)}`);
      } catch {
        return this.remember(command, "failed", `${reason} Rollback failed.`);
      }
    } finally {
      clearTimeout(timeout);
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

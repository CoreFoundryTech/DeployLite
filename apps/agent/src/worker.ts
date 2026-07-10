import { deploymentCommandSchema, type DeploymentCommand } from "@deploylite/contracts";
import { z } from "zod";
import type { CommandBusClient, DeploymentExecutionInput, DeploymentExecutionResult, ExecutorLogger } from "./executor/index.js";
import { redactEnvFileForLog } from "./redaction.js";

const executionInputSchema = z.object({
  command: deploymentCommandSchema,
  repoUrl: z.string().min(1),
  ref: z.string().min(1),
  projectSlug: z.string().min(1),
  envFile: z.object({ contents: z.string() }),
  healthUrl: z.string().url(),
  dryRun: z.boolean().optional()
});

export type AgentCommandTransport = CommandBusClient & {
  poll(agentId: string, signal: AbortSignal): Promise<DeploymentExecutionInput | null>;
};

export type DeploymentExecutorPort = {
  execute(input: DeploymentExecutionInput): Promise<DeploymentExecutionResult>;
};

export type AgentWorkerOptions = {
  agentId: string;
  transport: AgentCommandTransport;
  executor: DeploymentExecutorPort;
  logger?: ExecutorLogger;
  retryDelayMs?: number;
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
};

export class AgentWorker {
  readonly #logger: ExecutorLogger;
  readonly #retryDelayMs: number;
  readonly #wait: (milliseconds: number, signal: AbortSignal) => Promise<void>;

  constructor(private readonly options: AgentWorkerOptions) {
    this.#logger = options.logger ?? { log: () => undefined };
    this.#retryDelayMs = options.retryDelayMs ?? 1_000;
    this.#wait = options.wait ?? abortableWait;
  }

  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        const input = await this.options.transport.poll(this.options.agentId, signal);
        if (signal.aborted) break;
        if (!input) {
          await this.#wait(this.#retryDelayMs, signal);
          continue;
        }
        if (input.command.agentId !== this.options.agentId) {
          await this.safeLog("error", "Transport returned a command assigned to another agent");
          await this.#wait(this.#retryDelayMs, signal);
          continue;
        }
        await this.options.executor.execute(input);
      } catch (error) {
        if (signal.aborted) break;
        await this.safeLog("error", `Agent poll failed: ${safeError(error)}`);
        await this.#wait(this.#retryDelayMs, signal);
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
};

/** HTTP-only adapter. It uses fixed same-origin paths and never evaluates API output. */
export class HttpAgentCommandTransport implements AgentCommandTransport {
  readonly #baseUrl: URL;
  readonly #fetch: typeof fetch;

  constructor(private readonly options: HttpAgentTransportOptions) {
    this.#baseUrl = new URL(options.apiUrl);
    if (!/^https?:$/.test(this.#baseUrl.protocol)) throw new Error("Agent API URL must use HTTP or HTTPS");
    if (!options.token) throw new Error("Agent API token is required");
    this.#fetch = options.fetch ?? fetch;
  }

  async poll(agentId: string, signal: AbortSignal): Promise<DeploymentExecutionInput | null> {
    const result = await this.request(`/api/v1/agent/commands/next?agentId=${encodeURIComponent(agentId)}`, { method: "GET", signal });
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
    const response = await this.#fetch(url, {
      ...init,
      headers: { ...init.headers, authorization: `Bearer ${this.options.token}` }
    });
    if (response.status === 204) return null;
    if (!response.ok) throw new Error(`Agent API request failed with status ${response.status}`);
    return response.json();
  }
}

function safeError(error: unknown): string {
  return redactEnvFileForLog(error instanceof Error ? error.message : "Unknown transport error");
}

function abortableWait(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolveWait) => {
    if (signal.aborted) return resolveWait();
    const timer = setTimeout(resolveWait, milliseconds);
    signal.addEventListener("abort", () => { clearTimeout(timer); resolveWait(); }, { once: true });
  });
}

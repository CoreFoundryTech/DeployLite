import { AgentDeploymentExecutor, nodeWorkspaceFilesystem, spawnProcessRunner, type ExecutorLogger, type HealthProbe } from "./executor/index.js";
import { parseDeployLiteEnv } from "@deploylite/config";
import { redactEnvFileForLog } from "./redaction.js";
import { AgentWorker, HttpAgentCommandTransport } from "./worker.js";
import { DurableTerminalCommandBus, FileTerminalOutbox } from "./terminal-outbox.js";
import { FileCleanupRepairStore } from "./cleanup-repairs.js";
import { FileManagedBuilderRegistry } from "./managed-builders.js";
import { FileAgentReadiness } from "./readiness.js";
import { cpus, freemem, loadavg, totalmem } from "node:os";
import { statfs } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export async function runAgentEntrypoint(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  // Remove a previous process's opaque marker before any fallible startup work.
  // A failure here must leave the healthcheck closed rather than reporting stale readiness.
  const readiness = new FileAgentReadiness(env.DEPLOYLITE_AGENT_READINESS_PATH ?? "/var/lib/deploylite/state/agent-ready");
  await readiness.clear();
  const config = parseDeployLiteEnv(env);
  const agentId = required(config, "DEPLOYLITE_AGENT_ID");
  const agentName = required(config, "DEPLOYLITE_AGENT_NAME");
  const agentEndpoint = required(config, "DEPLOYLITE_AGENT_ENDPOINT");
  const agentToken = required(config, "DEPLOYLITE_AGENT_TOKEN");
  const transport = new HttpAgentCommandTransport({
    apiUrl: config.DEPLOYLITE_API_URL,
    token: agentToken
  });
  const logger: ExecutorLogger = { log: (level, message) => console[level](redactEnvFileForLog(message)) };
  const terminalBus = new DurableTerminalCommandBus(
    agentId,
    transport,
    new FileTerminalOutbox(env.DEPLOYLITE_AGENT_OUTBOX_PATH ?? "/var/lib/deploylite/state/terminal-acks.json"),
    undefined,
    (event) => logger.log("error", `${event.message} command=${event.commandId} attempted=${event.attemptedState} authoritative=${event.authoritativeState}`)
  );
  const health = createFetchHealthProbe();
  const executor = new AgentDeploymentExecutor(
    spawnProcessRunner,
    terminalBus,
    health,
    logger,
    undefined,
    nodeWorkspaceFilesystem,
    {
      workspaceRoot: env.DEPLOYLITE_AGENT_WORKSPACE_ROOT ?? "/var/lib/deploylite/workspaces",
      secretRoot: "/run/deploylite/secrets"
    },
    new FileCleanupRepairStore(env.DEPLOYLITE_AGENT_CLEANUP_REPAIR_PATH ?? "/var/lib/deploylite/state/cleanup-repairs.json"),
    new FileManagedBuilderRegistry(
      env.DEPLOYLITE_AGENT_BUILDER_REGISTRY_PATH ?? "/var/lib/deploylite/state/managed-builders.json",
      required(config, "DEPLOYLITE_AGENT_BUILDER_REGISTRY_INTEGRITY_KEY"),
      undefined,
      config.DEPLOYLITE_AGENT_BUILDER_REGISTRY_PREVIOUS_INTEGRITY_KEY
    ),
    {},
    { allowedHosts: requiredRepositoryHosts(config, env) }
  );
  const worker = new AgentWorker({
    agentId,
    agentName,
    agentEndpoint,
    transport,
    executor,
    terminalAcks: terminalBus,
    resourceCollector: {
      async collect() {
        const memoryTotalBytes = totalmem();
        const disk = await statfs("/");
        const diskTotalBytes = disk.blocks * disk.bsize;
        const diskAvailableBytes = disk.bavail * disk.bsize;
        return {
          cpuLoad: Math.min(1, Math.max(0, loadavg()[0]! / Math.max(1, cpus().length))),
          memoryUsedBytes: Math.max(0, memoryTotalBytes - freemem()),
          memoryTotalBytes,
          diskUsedBytes: Math.max(0, diskTotalBytes - diskAvailableBytes),
          diskTotalBytes
        };
      }
    },
    logger,
    readiness
  });
  const shutdown = new AbortController();
  const stop = () => shutdown.abort();
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  try {
    await worker.run(shutdown.signal);
  } finally {
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
  }
}

export function createFetchHealthProbe(fetchImpl: typeof fetch = fetch): HealthProbe {
  return {
    async probe(url, timeoutMs, signal) {
      const deadline = AbortSignal.timeout(timeoutMs);
      const controller = new AbortController();
      const abort = () => controller.abort();
      try {
        signal?.addEventListener("abort", abort, { once: true });
        deadline.addEventListener("abort", abort, { once: true });
        if (signal?.aborted || deadline.aborted) abort();
        const response = await fetchImpl(url, { signal: controller.signal });
        return response.ok;
      } catch { return false; }
      finally {
        signal?.removeEventListener("abort", abort);
        deadline.removeEventListener("abort", abort);
      }
    }
  };
}

function required(env: Record<string, unknown>, key: string): string {
  const raw = env[key];
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) throw new Error(`${key} is required`);
  return value;
}

function requiredRepositoryHosts(config: Record<string, unknown>, env: NodeJS.ProcessEnv): string[] {
  const configured = typeof config.DEPLOYLITE_REPO_ALLOWED_HOSTS === "string" ? config.DEPLOYLITE_REPO_ALLOWED_HOSTS : "";
  const hosts = configured.split(",").map((host) => host.trim()).filter(Boolean);
  if (hosts.length > 0) return hosts;
  if (env.NODE_ENV === "production") throw new Error("DEPLOYLITE_REPO_ALLOWED_HOSTS is required in production");
  return ["github.com"];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runAgentEntrypoint().catch((error: unknown) => {
    console.error(redactEnvFileForLog(error instanceof Error ? error.message : "Agent startup failed"));
    process.exitCode = 1;
  });
}

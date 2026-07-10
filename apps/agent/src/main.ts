import { AgentDeploymentExecutor, nodeWorkspaceFilesystem, spawnProcessRunner, type ExecutorLogger, type HealthProbe } from "./executor/index.js";
import { parseDeployLiteEnv } from "@deploylite/config";
import { redactEnvFileForLog } from "./redaction.js";
import { AgentWorker, HttpAgentCommandTransport } from "./worker.js";
import { DurableTerminalCommandBus, FileTerminalOutbox } from "./terminal-outbox.js";
import { cpus, freemem, loadavg, totalmem } from "node:os";
import { statfs } from "node:fs/promises";

export async function runAgentEntrypoint(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const config = parseDeployLiteEnv(env);
  const agentId = required(config, "DEPLOYLITE_AGENT_ID");
  const agentName = required(config, "DEPLOYLITE_AGENT_NAME");
  const agentEndpoint = required(config, "DEPLOYLITE_AGENT_ENDPOINT");
  const transport = new HttpAgentCommandTransport({
    apiUrl: config.DEPLOYLITE_API_URL,
    token: required(config, "DEPLOYLITE_AGENT_TOKEN")
  });
  const logger: ExecutorLogger = { log: (level, message) => console[level](redactEnvFileForLog(message)) };
  const terminalBus = new DurableTerminalCommandBus(
    agentId,
    transport,
    new FileTerminalOutbox(env.DEPLOYLITE_AGENT_OUTBOX_PATH ?? "/var/lib/deploylite/state/terminal-acks.json"),
    undefined,
    (event) => logger.log("error", `${event.message} command=${event.commandId} attempted=${event.attemptedState} authoritative=${event.authoritativeState}`)
  );
  const health: HealthProbe = {
    async probe(url, timeoutMs) {
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
        return response.ok;
      } catch { return false; }
    }
  };
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
    }
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
    logger
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

function required(env: Record<string, unknown>, key: string): string {
  const raw = env[key];
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) throw new Error(`${key} is required`);
  return value;
}

void runAgentEntrypoint().catch((error: unknown) => {
  console.error(redactEnvFileForLog(error instanceof Error ? error.message : "Agent startup failed"));
  process.exitCode = 1;
});

import {
  createCorrelationContext,
  createRequestId,
} from "@deploylite/config";
import { agentHeartbeatSchema, resourceSnapshotSchema, type AgentHeartbeat } from "@deploylite/contracts";
import { z } from "zod";

export * from "./executor/index.js";
export * from "./worker.js";
export * from "./redaction.js";
export * from "./terminal-outbox.js";
export {
  buildDeployEnvFile,
  materializeMockDeploy,
  type EncryptedEnvRecord,
  type EnvMaterializedEntry,
  type MaterializeDeployOptions
} from "@deploylite/domain";

export const safeCommandEnvelopeSchema = z.object({
  commandId: z.string().min(1),
  agentId: z.string().min(1),
  kind: z.enum(["heartbeat", "status-snapshot", "deploy.materialize"]),
  issuedAt: z.string().datetime({ offset: true }),
  payload: z.record(z.unknown()),
  safety: z.object({
    mockOnly: z.literal(true),
    dockerSocketAccess: z.literal(false),
    hostShellExecution: z.literal(false),
    mutatesHost: z.literal(false)
  })
});

export type SafeCommandEnvelope = z.infer<typeof safeCommandEnvelopeSchema>;

export type HeartbeatTransport = {
  sendHeartbeat(heartbeat: AgentHeartbeat): Promise<{ accepted: boolean; requestId: string }>;
};

export type MockHeartbeatClientOptions = {
  agentId: string;
  transport: HeartbeatTransport;
  now?: () => Date;
};

export const mockResourceSnapshot = resourceSnapshotSchema.parse({
  cpuLoad: 0.24,
  memoryUsedBytes: 512,
  memoryTotalBytes: 2048,
  diskUsedBytes: 10_000,
  diskTotalBytes: 100_000
});

export function createSafeCommandEnvelope(agentId: string, kind: SafeCommandEnvelope["kind"], issuedAt = new Date()): SafeCommandEnvelope {
  return safeCommandEnvelopeSchema.parse({
    commandId: `cmd_${createRequestId()}`,
    agentId,
    kind,
    issuedAt: issuedAt.toISOString(),
    payload: kind === "heartbeat" ? { resourceSnapshot: mockResourceSnapshot } : { status: "online" },
    safety: {
      mockOnly: true,
      dockerSocketAccess: false,
      hostShellExecution: false,
      mutatesHost: false
    }
  });
}

export class MockHeartbeatClient {
  constructor(private readonly options: MockHeartbeatClientOptions) {}

  async sendHeartbeat(): Promise<{ accepted: boolean; requestId: string; envelope: SafeCommandEnvelope }> {
    const issuedAt = this.options.now?.() ?? new Date();
    const envelope = createSafeCommandEnvelope(this.options.agentId, "heartbeat", issuedAt);
    const context = createCorrelationContext(createRequestId());
    const heartbeat = agentHeartbeatSchema.parse({
      agentId: this.options.agentId,
      observedAt: issuedAt.toISOString(),
      resourceSnapshot: mockResourceSnapshot,
      ...context
    });
    const result = await this.options.transport.sendHeartbeat(heartbeat);
    return { ...result, envelope };
  }
}

export function assertNoHostMutationPath(envelope: SafeCommandEnvelope): true {
  const parsed = safeCommandEnvelopeSchema.parse(envelope);
  if (!parsed.safety.mockOnly || parsed.safety.dockerSocketAccess || parsed.safety.hostShellExecution || parsed.safety.mutatesHost) {
    throw new Error("Unsafe agent command envelope rejected by scaffold boundary");
  }
  return true;
}

import { createCorrelationContext, redactSecrets } from "@deploylite/config";
import {
  agentSchema,
  deploymentSchema,
  logEventSchema,
  mcpToolResultSchema,
  requestContextSchema,
  type Agent,
  type Deployment,
  type LogEvent
} from "@deploylite/contracts";
import { z } from "zod";

const SCAFFOLD_REQUEST_ID = "mcp_mock_request_1";

export type McpToolAnnotations = {
  readOnlyHint: true;
  destructiveHint: false;
  idempotentHint: true;
  openWorldHint: false;
};

export type McpToolDefinition<Input extends z.ZodTypeAny, Output extends z.ZodTypeAny> = {
  name: string;
  title: string;
  description: string;
  inputSchema: Input;
  outputSchema: Output;
  annotations: McpToolAnnotations;
};

export type McpToolResponse<StructuredContent> = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: StructuredContent;
};

export type DeployLiteApiClient = {
  getServerStatus(): Promise<ServerStatusOutput>;
  listDeployments(input: ListDeploymentsInput): Promise<ListDeploymentsOutput>;
  getDeploymentLogs(input: DeploymentLogsInput): Promise<DeploymentLogsOutput>;
};

export type DeployLiteMcpTools = {
  deploylite_get_server_status(): Promise<ReturnType<typeof mcpToolResultSchema.parse>>;
  deploylite_list_deployments(input?: unknown): Promise<ReturnType<typeof mcpToolResultSchema.parse>>;
  deploylite_get_deployment_logs(input: unknown): Promise<ReturnType<typeof mcpToolResultSchema.parse>>;
};

const toolAnnotations: McpToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false
};

const deploymentLogsInputSchema = z.object({
  deploymentId: z.string().min(1).describe("Deployment identifier from deploylite_list_deployments."),
  afterSequence: z.number().int().nonnegative().optional().describe("Return log events after this sequence, mirroring Last-Event-ID resume semantics.")
});

const listDeploymentsInputSchema = z.object({
  status: deploymentSchema.shape.status.optional().describe("Optional deployment status filter.")
});

const serverStatusOutputSchema = requestContextSchema.extend({
  service: z.literal("deploylite"),
  mode: z.literal("mock-only"),
  safety: z.object({
    readOnly: z.literal(true),
    destructive: z.literal(false),
    dockerSocketAccess: z.literal(false),
    hostShellExecution: z.literal(false),
    traefikAcmeMutation: z.literal(false),
    productionAuthClaims: z.literal(false)
  }),
  agents: z.array(agentSchema),
  summary: z.object({
    agentCount: z.number().int().nonnegative(),
    onlineAgentCount: z.number().int().nonnegative()
  })
});

const listDeploymentsOutputSchema = requestContextSchema.extend({
  deployments: z.array(deploymentSchema),
  safety: z.object({ readOnly: z.literal(true), destructive: z.literal(false) })
});

const deploymentLogsOutputSchema = requestContextSchema.extend({
  deploymentId: z.string().min(1),
  events: z.array(logEventSchema),
  resume: z.object({ afterSequence: z.number().int().nonnegative().nullable(), nextAfterSequence: z.number().int().nonnegative().nullable() }),
  safety: z.object({ readOnly: z.literal(true), destructive: z.literal(false), redacted: z.literal(true) })
});

export type DeploymentLogsInput = z.infer<typeof deploymentLogsInputSchema>;
export type ListDeploymentsInput = z.infer<typeof listDeploymentsInputSchema>;
export type ServerStatusOutput = z.infer<typeof serverStatusOutputSchema>;
export type ListDeploymentsOutput = z.infer<typeof listDeploymentsOutputSchema>;
export type DeploymentLogsOutput = z.infer<typeof deploymentLogsOutputSchema>;

export const deployLiteMcpToolDefinitions = {
  getServerStatus: {
    name: "deploylite_get_server_status",
    title: "Get DeployLite server status",
    description: "Read-only, non-destructive mock server and agent status. Does not access Docker, Traefik, ACME, host shells, or production auth.",
    inputSchema: z.object({}),
    outputSchema: serverStatusOutputSchema,
    annotations: toolAnnotations
  },
  listDeployments: {
    name: "deploylite_list_deployments",
    title: "List DeployLite deployments",
    description: "Read-only, non-destructive deployment record listing from the mock control-plane contract.",
    inputSchema: listDeploymentsInputSchema,
    outputSchema: listDeploymentsOutputSchema,
    annotations: toolAnnotations
  },
  getDeploymentLogs: {
    name: "deploylite_get_deployment_logs",
    title: "Get DeployLite deployment logs",
    description: "Read-only, non-destructive redacted log retrieval with request and correlation metadata. Supports reconnect-style afterSequence filtering.",
    inputSchema: deploymentLogsInputSchema,
    outputSchema: deploymentLogsOutputSchema,
    annotations: toolAnnotations
  }
} satisfies Record<string, McpToolDefinition<z.ZodTypeAny, z.ZodTypeAny>>;

function asToolResponse<StructuredContent extends { requestId: string; correlationId: string }>(structuredContent: StructuredContent): McpToolResponse<StructuredContent> & {
  requestId: string;
  correlationId: string;
} {
  const safeStructuredContent = redactSecrets(structuredContent);
  return {
    requestId: safeStructuredContent.requestId,
    correlationId: safeStructuredContent.correlationId,
    content: [{ type: "text", text: JSON.stringify(safeStructuredContent) }],
    structuredContent: safeStructuredContent
  };
}

export function createDeployLiteMcpTools(apiClient: DeployLiteApiClient): DeployLiteMcpTools {
  return {
    deploylite_get_server_status: async () => {
      const output = serverStatusOutputSchema.parse(await apiClient.getServerStatus());
      return mcpToolResultSchema.parse(asToolResponse(output));
    },
    deploylite_list_deployments: async (input: unknown = {}) => {
      const parsedInput = listDeploymentsInputSchema.parse(input);
      const output = listDeploymentsOutputSchema.parse(await apiClient.listDeployments(parsedInput));
      return mcpToolResultSchema.parse(asToolResponse(output));
    },
    deploylite_get_deployment_logs: async (input: unknown) => {
      const parsedInput = deploymentLogsInputSchema.parse(input);
      const output = deploymentLogsOutputSchema.parse(await apiClient.getDeploymentLogs(parsedInput));
      return mcpToolResultSchema.parse(asToolResponse(output));
    }
  };
}

export function createMockDeployLiteApiClient(requestId = SCAFFOLD_REQUEST_ID): DeployLiteApiClient {
  const context = createCorrelationContext(requestId);
  const agents: Agent[] = [
    {
      id: "agent_mock_1",
      name: "Mock VPS Agent",
      endpoint: "https://agent.example.test",
      status: "online",
      lastHeartbeatAt: "2026-01-01T00:00:00.000Z",
      resourceSnapshot: { cpuLoad: 0.24, memoryUsedBytes: 512, memoryTotalBytes: 2048, diskUsedBytes: 10_000, diskTotalBytes: 100_000 }
    }
  ];
  const deployments: Deployment[] = [
    {
      id: "dep_mock_1",
      projectId: "project_mock_1",
      agentId: "agent_mock_1",
      status: "running",
      commitSha: "abcdef1",
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: null
    }
  ];
  const logs: LogEvent[] = [
    {
      id: "log_1",
      deploymentId: "dep_mock_1",
      sequence: 1,
      level: "info",
      message: "Preparing deployment",
      timestamp: "2026-01-01T00:00:00.000Z",
      redactionApplied: true,
      ...context
    },
    {
      id: "log_2",
      deploymentId: "dep_mock_1",
      sequence: 2,
      level: "info",
      message: "Using token dl_1234567890abcdef for mock fixture",
      timestamp: "2026-01-01T00:00:01.000Z",
      redactionApplied: true,
      ...context
    }
  ];

  return {
    async getServerStatus() {
      return serverStatusOutputSchema.parse({
        ...context,
        service: "deploylite",
        mode: "mock-only",
        safety: {
          readOnly: true,
          destructive: false,
          dockerSocketAccess: false,
          hostShellExecution: false,
          traefikAcmeMutation: false,
          productionAuthClaims: false
        },
        agents,
        summary: { agentCount: agents.length, onlineAgentCount: agents.filter((agent) => agent.status === "online").length }
      });
    },
    async listDeployments(input) {
      return listDeploymentsOutputSchema.parse({
        ...context,
        deployments: input.status ? deployments.filter((deployment) => deployment.status === input.status) : deployments,
        safety: { readOnly: true, destructive: false }
      });
    },
    async getDeploymentLogs(input) {
      const events = logs.filter((event) => event.deploymentId === input.deploymentId && event.sequence > (input.afterSequence ?? -1));
      const nextAfterSequence = events.at(-1)?.sequence ?? null;
      return deploymentLogsOutputSchema.parse({
        ...context,
        deploymentId: input.deploymentId,
        events,
        resume: { afterSequence: input.afterSequence ?? null, nextAfterSequence },
        safety: { readOnly: true, destructive: false, redacted: true }
      });
    }
  };
}

export const deployLiteMcpTools = createDeployLiteMcpTools(createMockDeployLiteApiClient());

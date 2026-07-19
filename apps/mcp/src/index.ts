import { createCorrelationContext, redactSecrets } from "@deploylite/config";
import {
  agentSchema,
  deploymentSchema,
  logEventSchema,
  mcpToolResultSchema,
  requestContextSchema,
  type Agent,
  type Deployment,
  type LogEvent,
  type Project
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
  listProjects(): Promise<Project[]>;
  listAuditEvents(): Promise<McpAuditEvent[]>;
};

export type McpAuditEvent = {
  id: string;
  actorId: string;
  action: string;
  projectId: string;
  targetType: string;
  targetId: string;
  requestId: string;
  correlationId: string;
  timestamp: string;
  [key: string]: unknown;
};

export type ReadGrant = {
  permission: "project.read" | "audit.read";
  scope: "platform" | "project";
  projectId?: string;
};

export type McpReadContext = { actorId: string; grants: readonly ReadGrant[] };
export type McpReadErrorContext = { requestId: string; correlationId: string };

export type McpReadAuthorizer = {
  projectScopes(context: McpReadContext, errorContext: McpReadErrorContext): "platform" | ReadonlySet<string>;
  assertAuditScope(context: McpReadContext, projectId: string | undefined, errorContext: McpReadErrorContext): void;
};

export type DeployLiteMcpTools = {
  deploylite_get_server_status(): Promise<ReturnType<typeof mcpToolResultSchema.parse>>;
  deploylite_list_deployments(input?: unknown): Promise<ReturnType<typeof mcpToolResultSchema.parse>>;
  deploylite_get_deployment_logs(input: unknown): Promise<ReturnType<typeof mcpToolResultSchema.parse>>;
  deploylite_list_projects(input: unknown): Promise<ReturnType<typeof mcpToolResultSchema.parse>>;
  deploylite_list_audit_events(input?: unknown): Promise<ReturnType<typeof mcpToolResultSchema.parse>>;
  deploylite_get_project_context(input: unknown): Promise<ReturnType<typeof mcpToolResultSchema.parse>>;
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

const nonBlankExactString = z.string().min(1).refine((value) => value.trim() === value, "Filters must not include surrounding whitespace.");

const listProjectsInputSchema = z.object({}).strict();

const projectContextInputSchema = z.object({
  projectId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/)
}).strict();

const listAuditEventsInputSchema = z.object({
  projectId: nonBlankExactString.optional(),
  action: nonBlankExactString.optional(),
  actor: nonBlankExactString.optional(),
  offset: z.number().int().min(0).max(10_000).default(0),
  limit: z.number().int().min(1).max(200).default(50)
}).strict();

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

const safeProjectSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  defaultBranch: z.string().min(1),
  port: z.number().int().min(1).max(65_535).nullable(),
  description: z.string().max(2_000).nullable(),
  imageTag: z.string().min(1).max(256).nullable()
});

const safeAuditEventSchema = z.object({
  id: z.string().min(1),
  actorId: z.string().min(1),
  action: z.string().min(1),
  projectId: z.string().min(1),
  targetType: z.string().min(1),
  targetId: z.string().min(1),
  requestId: z.string().min(1),
  correlationId: z.string().min(1),
  timestamp: z.string().datetime({ offset: true })
});

const safeDeploymentSchema = z.object({
  id: z.string().min(1),
  status: deploymentSchema.shape.status,
  commitSha: z.string().regex(/^[a-f0-9]{7,40}$/),
  startedAt: z.string().datetime({ offset: true }),
  finishedAt: z.string().datetime({ offset: true }).nullable()
});

const projectContextOutputSchema = requestContextSchema.extend({
  project: safeProjectSchema,
  latestDeployment: safeDeploymentSchema.nullable(),
  readiness: z.object({
    status: z.enum(["ready", "attention", "not_configured"]),
    reason: z.string().min(1),
    mode: z.literal("mock-only"),
    advisory: z.literal("non-executing; not production-health evidence")
  })
});

const listProjectsOutputSchema = requestContextSchema.extend({
  projects: z.array(safeProjectSchema),
  safety: z.object({ readOnly: z.literal(true), destructive: z.literal(false), redacted: z.literal(true), mode: z.literal("mock-only") })
});

const listAuditEventsOutputSchema = requestContextSchema.extend({
  events: z.array(safeAuditEventSchema),
  total: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  safety: z.object({ readOnly: z.literal(true), destructive: z.literal(false), redacted: z.literal(true), mode: z.literal("mock-only") })
});

export type DeploymentLogsInput = z.infer<typeof deploymentLogsInputSchema>;
export type ListDeploymentsInput = z.infer<typeof listDeploymentsInputSchema>;
export type ServerStatusOutput = z.infer<typeof serverStatusOutputSchema>;
export type ListDeploymentsOutput = z.infer<typeof listDeploymentsOutputSchema>;
export type DeploymentLogsOutput = z.infer<typeof deploymentLogsOutputSchema>;
export type ListProjectsInput = z.infer<typeof listProjectsInputSchema>;
export type ListAuditEventsInput = z.infer<typeof listAuditEventsInputSchema>;
export type ListProjectsOutput = z.infer<typeof listProjectsOutputSchema>;
export type ListAuditEventsOutput = z.infer<typeof listAuditEventsOutputSchema>;
export type ProjectContextInput = z.infer<typeof projectContextInputSchema>;
export type ProjectContextOutput = z.infer<typeof projectContextOutputSchema>;

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
  },
  listProjects: {
    name: "deploylite_list_projects",
    title: "List DeployLite projects",
    description: "Read-only, non-destructive mock-only project inventory. Visibility is constrained by injected local authorization grants.",
    inputSchema: listProjectsInputSchema,
    outputSchema: listProjectsOutputSchema,
    annotations: toolAnnotations
  },
  listAuditEvents: {
    name: "deploylite_list_audit_events",
    title: "List DeployLite audit events",
    description: "Read-only, non-destructive mock-only audit visibility with exact filters, bounded pages, and injected local authorization grants.",
    inputSchema: listAuditEventsInputSchema,
    outputSchema: listAuditEventsOutputSchema,
    annotations: toolAnnotations
  },
  getProjectContext: {
    name: "deploylite_get_project_context",
    title: "Get DeployLite project context",
    description: "Read-only, non-destructive mock-only project context with authorized safe fields and advisory readiness.",
    inputSchema: projectContextInputSchema,
    outputSchema: projectContextOutputSchema,
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

export class McpReadForbiddenError extends Error {
  readonly code = "FORBIDDEN";

  constructor(readonly requestId: string, readonly correlationId: string) {
    super("FORBIDDEN");
    this.name = "McpReadForbiddenError";
  }
}

export class McpReadNotFoundError extends Error {
  readonly code = "NOT_FOUND";

  constructor(readonly requestId: string, readonly correlationId: string) {
    super("NOT_FOUND");
    this.name = "McpReadNotFoundError";
  }
}

const defaultReadContext: McpReadContext = {
  actorId: "mcp_mock_actor_1",
  grants: [
    { permission: "project.read", scope: "platform" },
    { permission: "audit.read", scope: "platform" }
  ]
};

function scopedGrants(context: McpReadContext, permission: ReadGrant["permission"]): "platform" | ReadonlySet<string> | null {
  const grants = context.grants.filter((grant) => grant.permission === permission);
  if (grants.some((grant) => grant.scope === "platform")) return "platform";
  const projectIds = grants.flatMap((grant) => grant.scope === "project" && grant.projectId ? [grant.projectId] : []);
  return projectIds.length > 0 ? new Set(projectIds) : null;
}

export const defaultMcpReadAuthorizer: McpReadAuthorizer = {
  projectScopes(context, errorContext) {
    return scopedGrants(context, "project.read") ?? deny(errorContext);
  },
  assertAuditScope(context, projectId, errorContext) {
    const scopes = scopedGrants(context, "audit.read");
    if (scopes === "platform") return;
    if (!projectId || !scopes?.has(projectId)) deny(errorContext);
  }
};

function deny(errorContext: McpReadErrorContext): never {
  throw new McpReadForbiddenError(errorContext.requestId, errorContext.correlationId);
}

function safeProject(project: Project): z.infer<typeof safeProjectSchema> {
  return {
    id: project.id,
    name: project.name,
    defaultBranch: project.defaultBranch,
    port: project.port,
    description: project.description,
    imageTag: project.imageTag
  };
}

function safeAuditEvent(event: McpAuditEvent): z.infer<typeof safeAuditEventSchema> {
  return {
    id: event.id,
    actorId: event.actorId,
    action: event.action,
    projectId: event.projectId,
    targetType: event.targetType,
    targetId: event.targetId,
    requestId: event.requestId,
    correlationId: event.correlationId,
    timestamp: event.timestamp
  };
}

function safeDeployment(deployment: Deployment): z.infer<typeof safeDeploymentSchema> {
  return {
    id: deployment.id,
    status: deployment.status,
    commitSha: deployment.commitSha,
    startedAt: deployment.startedAt,
    finishedAt: deployment.finishedAt
  };
}

function latestProjectDeployment(deployments: readonly Deployment[], projectId: string): Deployment | null {
  const candidatesByInstant = deployments
    .filter((deployment) => deployment.projectId === projectId)
    .map((deployment) => ({ deployment, epochMs: Date.parse(deployment.startedAt) }))
    .filter(({ deployment, epochMs }) => Number.isFinite(epochMs) && safeDeploymentSchema.safeParse(safeDeployment(deployment)).success);

  return candidatesByInstant
    .sort((left, right) => right.epochMs - left.epochMs || right.deployment.id.localeCompare(left.deployment.id))[0]
    ?.deployment ?? null;
}

function projectReadiness(project: Project, deployment: Deployment | null): z.infer<typeof projectContextOutputSchema.shape.readiness> {
  const configured = project.buildCommand !== null && project.runCommand !== null && project.port !== null && project.imageTag !== null;
  const reason = !configured
    ? "incomplete_configuration"
    : !deployment
      ? "no_deployment"
      : `latest_deployment_${deployment.status}`;
  return {
    status: !configured || !deployment ? "not_configured" : deployment.status === "succeeded" ? "ready" : "attention",
    reason,
    mode: "mock-only",
    advisory: "non-executing; not production-health evidence"
  };
}

export function createDeployLiteMcpTools(
  apiClient: DeployLiteApiClient,
  options: { readContext?: McpReadContext; authorizer?: McpReadAuthorizer; requestId?: string } = {}
): DeployLiteMcpTools {
  const sourceContext = options.readContext ?? defaultReadContext;
  const readContext: McpReadContext = Object.freeze({
    actorId: sourceContext.actorId,
    grants: Object.freeze(sourceContext.grants.map((grant) => Object.freeze({ ...grant })))
  });
  const authorizer = options.authorizer ?? defaultMcpReadAuthorizer;
  const responseContext = createCorrelationContext(options.requestId ?? SCAFFOLD_REQUEST_ID);
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
    },
    deploylite_list_projects: async (input: unknown) => {
      listProjectsInputSchema.parse(input);
      const scopes = authorizer.projectScopes(readContext, responseContext);
      const projects = (await apiClient.listProjects())
        .filter((project) => scopes === "platform" || scopes.has(project.id))
        .map(safeProject)
        .sort((left, right) => left.name.normalize("NFKC").toLowerCase().localeCompare(right.name.normalize("NFKC").toLowerCase()) || left.id.localeCompare(right.id));
      const output = listProjectsOutputSchema.parse({
        ...responseContext,
        projects,
        safety: { readOnly: true, destructive: false, redacted: true, mode: "mock-only" }
      });
      return mcpToolResultSchema.parse(asToolResponse(output));
    },
    deploylite_list_audit_events: async (input: unknown = {}) => {
      const parsedInput = listAuditEventsInputSchema.parse(input);
      authorizer.assertAuditScope(readContext, parsedInput.projectId, responseContext);
      const matching = (await apiClient.listAuditEvents())
        .filter((event) => (!parsedInput.projectId || event.projectId === parsedInput.projectId) && (!parsedInput.action || event.action === parsedInput.action) && (!parsedInput.actor || event.actorId === parsedInput.actor))
        .map(safeAuditEvent)
        .sort((left, right) => right.timestamp.localeCompare(left.timestamp) || left.id.localeCompare(right.id));
      const output = listAuditEventsOutputSchema.parse({
        ...responseContext,
        events: matching.slice(parsedInput.offset, parsedInput.offset + parsedInput.limit),
        total: matching.length,
        offset: parsedInput.offset,
        limit: parsedInput.limit,
        safety: { readOnly: true, destructive: false, redacted: true, mode: "mock-only" }
      });
      return mcpToolResultSchema.parse(asToolResponse(output));
    },
    deploylite_get_project_context: async (input: unknown) => {
      const parsedInput = projectContextInputSchema.parse(input);
      const scopes = authorizer.projectScopes(readContext, responseContext);
      if (scopes !== "platform" && !scopes.has(parsedInput.projectId)) deny(responseContext);
      const project = (await apiClient.listProjects()).find(({ id }) => id === parsedInput.projectId);
      if (!project) throw new McpReadNotFoundError(responseContext.requestId, responseContext.correlationId);
      const deployments = (await apiClient.listDeployments({})).deployments;
      const latestDeployment = latestProjectDeployment(deployments, project.id);
      const output = projectContextOutputSchema.parse({
        ...responseContext,
        project: safeProject(project),
        latestDeployment: latestDeployment ? safeDeployment(latestDeployment) : null,
        readiness: projectReadiness(project, latestDeployment)
      });
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
  // These fixtures deliberately retain fields that the MCP serializers must
  // never expose. The handlers project named safe fields before serialization.
  const projects: Project[] = [
    {
      id: "project_mock_1",
      name: "Mock Project",
      repoUrl: "https://credential@example.test/mock-project.git",
      defaultBranch: "main",
      buildCommand: "pnpm build --token=mock-secret",
      runCommand: "pnpm start --password=mock-secret",
      port: 3000,
      description: "Deterministic mock project.",
      imageTag: "mock:latest"
    }
  ];
  const auditEvents: McpAuditEvent[] = [
    {
      id: "audit_mock_1",
      actorId: "mcp_mock_actor_1",
      action: "project.read",
      projectId: "project_mock_1",
      targetType: "project",
      targetId: "project_mock_1",
      requestId: context.requestId,
      correlationId: context.correlationId,
      timestamp: "2026-01-01T00:00:02.000Z",
      metadata: { token: "mock-secret", unknown: "not-for-mcp" }
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
    },
    async listProjects() {
      return structuredClone(projects);
    },
    async listAuditEvents() {
      return structuredClone(auditEvents);
    }
  };
}

export const deployLiteMcpTools = createDeployLiteMcpTools(createMockDeployLiteApiClient());

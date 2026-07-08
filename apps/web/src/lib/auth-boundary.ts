import {
  agentSchema,
  auditEventListPageSchema,
  authResponseSchema,
  bootstrapInitialAdminRequestSchema,
  bootstrapStatusSchema,
  deploymentSchema,
  envVariableMetadataSchema,
  envSecretValueDeleteRequestSchema,
  envSecretValueSchema,
  envSecretValueWriteRequestSchema,
  logEventSchema,
  projectCreateRequestSchema,
  projectSchema,
  projectUpdateRequestSchema,
  responseEnvelopeSchema,
  type Agent,
  type AuditEventListPage,
  type AuthResponse,
  type BootstrapInitialAdminRequest,
  type BootstrapStatus,
  type Deployment,
  type EnvSecretValue,
  type EnvVariableMetadata,
  type LogEvent,
  type Project,
  type ProjectCreateRequest,
  type ProjectUpdateRequest,
  type SafeAuthUserDto
} from "@deploylite/contracts";
import { z } from "zod";

export const authApiPaths = {
  login: "/api/v1/auth/login",
  me: "/api/v1/auth/me",
  logout: "/api/v1/auth/logout"
} as const;

export const bootstrapApiPaths = {
  status: "/api/v1/bootstrap/status",
  initialAdmin: "/api/v1/bootstrap/initial-admin"
} as const;

export const metadataApiPaths = {
  agents: "/api/v1/agents",
  projects: "/api/v1/projects",
  project: (projectId: string) => `/api/v1/projects/${encodeURIComponent(projectId)}`,
  projectEnvVariables: (projectId: string) => `/api/v1/projects/${encodeURIComponent(projectId)}/env-variables`,
  projectEnvValues: (projectId: string) => `/api/v1/projects/${encodeURIComponent(projectId)}/env-values`,
  projectDeployments: (projectId: string) => `/api/v1/projects/${encodeURIComponent(projectId)}/deployments`,
  deployments: "/api/v1/deployments",
  deployment: (deploymentId: string) => `/api/v1/deployments/${encodeURIComponent(deploymentId)}`,
  deploymentLogs: (deploymentId: string) => `/api/v1/deployments/${encodeURIComponent(deploymentId)}/logs`,
  auditEvents: "/api/v1/audit-events"
} as const;

export type AuthApiRequestMethod = "GET" | "POST" | "PATCH" | "DELETE";

export const defaultSessionCookieName = "deploylite_session";

export type AuthBoundaryReason = "missing-cookie" | "api-unconfigured" | "api-rejected" | "api-unreachable";

export type AuthBoundaryState =
  | { kind: "authenticated"; user: SafeAuthUserDto }
  | { kind: "unauthenticated"; reason: AuthBoundaryReason };

export type MetadataApiFailureReason = "api-unconfigured" | "api-rejected" | "api-unreachable" | "invalid-payload";

export type MetadataApiResult<Data> =
  | { kind: "ready"; data: Data; requestId: string }
  | { kind: "error"; reason: MetadataApiFailureReason; status?: number };

export type BootstrapApiResult = MetadataApiResult<BootstrapStatus>;
export type InitialAdminApiResult = MetadataApiResult<AuthResponse>;

export type DashboardMetadata = {
  agents: Agent[];
  projects: Project[];
  deployments: Deployment[];
};

export type DeploymentLogMetadata = {
  deployment: Deployment | null;
  events: LogEvent[];
};

export type ProjectDetailMetadata = {
  project: Project;
  envVariables: EnvVariableMetadata[];
  deployments: Deployment[];
};

export type AuthApiRequestOptions = {
  method: AuthApiRequestMethod;
  body?: unknown;
};

export type LoadAuthSessionOptions = {
  apiBaseUrl?: string;
  cookieHeader?: string;
  fetchImpl?: typeof fetch;
};

export type MetadataApiFetchOptions = LoadAuthSessionOptions & {
  path: string;
  schema: z.ZodTypeAny;
};

type ApiEnvelope<Data> = {
  data: Data | null;
  error: { code: string; message: string; correlationId: string } | null;
  requestId: string;
};

export function getAuthApiBaseUrl(env: Record<string, string | undefined> = process.env): string | null {
  return env.DEPLOYLITE_WEB_API_BASE_URL ?? env.NEXT_PUBLIC_DEPLOYLITE_API_URL ?? null;
}

export function createAuthApiUrl(path: string, apiBaseUrl: string): string {
  return new URL(path, apiBaseUrl).toString();
}

export function createAuthApiRequest(options: AuthApiRequestOptions): RequestInit {
  return {
    method: options.method,
    credentials: "include",
    headers: options.body ? { "content-type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined
  };
}

export function createInitialAdminApiRequest(input: BootstrapInitialAdminRequest): RequestInit {
  return createAuthApiRequest({
    method: "POST",
    body: bootstrapInitialAdminRequestSchema.parse(input)
  });
}

export async function fetchMetadataEnvelope<Data>(options: MetadataApiFetchOptions): Promise<MetadataApiResult<Data>> {
  if (!options.apiBaseUrl) {
    return { kind: "error", reason: "api-unconfigured" };
  }

  try {
    const response = await (options.fetchImpl ?? fetch)(createAuthApiUrl(options.path, options.apiBaseUrl), {
      ...createAuthApiRequest({ method: "GET" }),
      headers: { cookie: options.cookieHeader ?? "" }
    });

    if (!response.ok) {
      return { kind: "error", reason: "api-rejected", status: response.status };
    }

    const envelope = responseEnvelopeSchema(options.schema).safeParse(await response.json());
    if (!envelope.success || !envelope.data.data) {
      return { kind: "error", reason: "invalid-payload" };
    }

    return { kind: "ready", data: envelope.data.data as Data, requestId: envelope.data.requestId };
  } catch {
    return { kind: "error", reason: "api-unreachable" };
  }
}

export function parseApiEnvelope<Data>(payload: unknown, schema: z.ZodType<Data>): MetadataApiResult<Data> {
  const envelope = responseEnvelopeSchema(schema).safeParse(payload) as
    | { success: false }
    | { success: true; data: { data: Data | null; requestId: string } };
  if (!envelope.success) {
    return { kind: "error", reason: "invalid-payload" };
  }

  const data = envelope.data.data as Data | null;
  if (!data) {
    return { kind: "error", reason: "invalid-payload" };
  }

  return { kind: "ready", data, requestId: envelope.data.requestId };
}

export async function loadBootstrapStatus(options: LoadAuthSessionOptions): Promise<BootstrapApiResult> {
  return fetchMetadataEnvelope<BootstrapStatus>({
    ...options,
    path: bootstrapApiPaths.status,
    schema: bootstrapStatusSchema
  });
}

export async function createInitialAdmin(options: LoadAuthSessionOptions & { input: BootstrapInitialAdminRequest }): Promise<InitialAdminApiResult> {
  if (!options.apiBaseUrl) {
    return { kind: "error", reason: "api-unconfigured" };
  }

  try {
    const response = await (options.fetchImpl ?? fetch)(createAuthApiUrl(bootstrapApiPaths.initialAdmin, options.apiBaseUrl), createInitialAdminApiRequest(options.input));
    if (!response.ok) {
      return { kind: "error", reason: "api-rejected", status: response.status };
    }

    return parseApiEnvelope(await response.json(), authResponseSchema);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return { kind: "error", reason: "invalid-payload" };
    }

    return { kind: "error", reason: "api-unreachable" };
  }
}

export async function loadDashboardMetadata(options: LoadAuthSessionOptions): Promise<MetadataApiResult<DashboardMetadata>> {
  const [projects, agents, deployments] = await Promise.all([
    fetchMetadataEnvelope<{ projects: Project[] }>({ ...options, path: metadataApiPaths.projects, schema: z.object({ projects: z.array(projectSchema) }) }),
    fetchMetadataEnvelope<{ agents: Agent[] }>({ ...options, path: metadataApiPaths.agents, schema: z.object({ agents: z.array(agentSchema) }) }),
    fetchMetadataEnvelope<{ deployments: Deployment[] }>({ ...options, path: metadataApiPaths.deployments, schema: z.object({ deployments: z.array(deploymentSchema) }) })
  ]);

  if (projects.kind === "error") return projects;
  if (agents.kind === "error") return agents;
  if (deployments.kind === "error") return deployments;

  return {
    kind: "ready",
    data: { projects: projects.data.projects, agents: agents.data.agents, deployments: deployments.data.deployments },
    requestId: projects.requestId
  };
}

export async function loadDeploymentLogMetadata(deploymentId: string, options: LoadAuthSessionOptions): Promise<MetadataApiResult<DeploymentLogMetadata>> {
  const [deployment, logs] = await Promise.all([
    fetchMetadataEnvelope<{ deployment: Deployment }>({ ...options, path: metadataApiPaths.deployment(deploymentId), schema: z.object({ deployment: deploymentSchema }) }),
    fetchMetadataEnvelope<{ events: LogEvent[] }>({ ...options, path: metadataApiPaths.deploymentLogs(deploymentId), schema: z.object({ events: z.array(logEventSchema) }) })
  ]);

  if (deployment.kind === "error" && deployment.status === 404) {
    return logs.kind === "ready" ? { kind: "ready", data: { deployment: null, events: logs.data.events }, requestId: logs.requestId } : logs;
  }

  if (deployment.kind === "error") {
    return deployment;
  }

  if (logs.kind === "error") {
    return logs;
  }

  return { kind: "ready", data: { deployment: deployment.data.deployment, events: logs.data.events }, requestId: deployment.requestId };
}

export async function loadProjectDetailMetadata(projectId: string, options: LoadAuthSessionOptions): Promise<MetadataApiResult<ProjectDetailMetadata>> {
  const [project, envVariables, deployments] = await Promise.all([
    fetchMetadataEnvelope<{ project: Project }>({ ...options, path: metadataApiPaths.project(projectId), schema: z.object({ project: projectSchema }) }),
    fetchMetadataEnvelope<{ envVariables: EnvVariableMetadata[] }>({ ...options, path: metadataApiPaths.projectEnvVariables(projectId), schema: z.object({ envVariables: z.array(envVariableMetadataSchema) }) }),
    fetchMetadataEnvelope<{ deployments: Deployment[] }>({ ...options, path: metadataApiPaths.deployments, schema: z.object({ deployments: z.array(deploymentSchema) }) })
  ]);

  if (project.kind === "error") return project;
  if (envVariables.kind === "error") return envVariables;
  if (deployments.kind === "error") return deployments;

  return {
    kind: "ready",
    data: {
      project: project.data.project,
      envVariables: envVariables.data.envVariables,
      deployments: deployments.data.deployments.filter((deployment) => deployment.projectId === projectId)
    },
    requestId: project.requestId
  };
}

export async function createProject(input: ProjectCreateRequest, options: LoadAuthSessionOptions): Promise<MetadataApiResult<{ project: Project }>> {
  if (!options.apiBaseUrl) return { kind: "error", reason: "api-unconfigured" };
  try {
    const response = await (options.fetchImpl ?? fetch)(createAuthApiUrl(metadataApiPaths.projects, options.apiBaseUrl), {
      ...createAuthApiRequest({ method: "POST", body: projectCreateRequestSchema.parse(input) }),
      headers: { cookie: options.cookieHeader ?? "" }
    });
    if (!response.ok) return { kind: "error", reason: "api-rejected", status: response.status };
    return parseApiEnvelope(await response.json(), z.object({ project: projectSchema }));
  } catch (error) {
    if (error instanceof z.ZodError) return { kind: "error", reason: "invalid-payload" };
    return { kind: "error", reason: "api-unreachable" };
  }
}

export async function updateProject(projectId: string, input: ProjectUpdateRequest, options: LoadAuthSessionOptions): Promise<MetadataApiResult<{ project: Project }>> {
  if (!options.apiBaseUrl) return { kind: "error", reason: "api-unconfigured" };
  try {
    const response = await (options.fetchImpl ?? fetch)(createAuthApiUrl(metadataApiPaths.project(projectId), options.apiBaseUrl), {
      ...createAuthApiRequest({ method: "PATCH", body: projectUpdateRequestSchema.parse(input) }),
      headers: { cookie: options.cookieHeader ?? "" }
    });
    if (!response.ok) return { kind: "error", reason: "api-rejected", status: response.status };
    return parseApiEnvelope(await response.json(), z.object({ project: projectSchema }));
  } catch (error) {
    if (error instanceof z.ZodError) return { kind: "error", reason: "invalid-payload" };
    return { kind: "error", reason: "api-unreachable" };
  }
}

export async function triggerProjectDeployment(projectId: string, options: LoadAuthSessionOptions): Promise<MetadataApiResult<{ deployment: Deployment }>> {
  if (!options.apiBaseUrl) return { kind: "error", reason: "api-unconfigured" };
  try {
    const response = await (options.fetchImpl ?? fetch)(createAuthApiUrl(metadataApiPaths.projectDeployments(projectId), options.apiBaseUrl), {
      ...createAuthApiRequest({ method: "POST", body: {} }),
      headers: { cookie: options.cookieHeader ?? "" }
    });
    if (!response.ok) return { kind: "error", reason: "api-rejected", status: response.status };
    return parseApiEnvelope(await response.json(), z.object({ deployment: deploymentSchema }));
  } catch {
    return { kind: "error", reason: "api-unreachable" };
  }
}

export async function upsertEnvVariable(projectId: string, input: { key: string; scope?: "project" | "deployment"; required?: boolean; description?: string | null }, options: LoadAuthSessionOptions): Promise<MetadataApiResult<{ envVariable: EnvVariableMetadata }>> {
  if (!options.apiBaseUrl) return { kind: "error", reason: "api-unconfigured" };
  try {
    const response = await (options.fetchImpl ?? fetch)(createAuthApiUrl(metadataApiPaths.projectEnvVariables(projectId), options.apiBaseUrl), {
      ...createAuthApiRequest({
        method: "POST",
        body: {
          key: input.key,
          scope: input.scope ?? "project",
          required: input.required ?? false,
          description: input.description ?? null
        }
      }),
      headers: { cookie: options.cookieHeader ?? "" }
    });
    if (!response.ok) return { kind: "error", reason: "api-rejected", status: response.status };
    return parseApiEnvelope(await response.json(), z.object({ envVariable: envVariableMetadataSchema }));
  } catch {
    return { kind: "error", reason: "api-unreachable" };
  }
}

export type DeleteProjectFailureReason = "api-unconfigured" | "api-rejected" | "api-unreachable" | "not-found" | "invalid-payload";

export type DeleteProjectResult =
  | { kind: "deleted" }
  | { kind: "error"; reason: DeleteProjectFailureReason; status?: number };

export async function deleteProject(projectId: string, options: LoadAuthSessionOptions): Promise<DeleteProjectResult> {
  if (!options.apiBaseUrl) return { kind: "error", reason: "api-unconfigured" };
  try {
    const response = await (options.fetchImpl ?? fetch)(createAuthApiUrl(metadataApiPaths.project(projectId), options.apiBaseUrl), {
      ...createAuthApiRequest({ method: "DELETE" }),
      headers: { cookie: options.cookieHeader ?? "" }
    });
    if (response.status === 404) {
      return { kind: "error", reason: "not-found", status: 404 };
    }
    if (!response.ok) {
      return { kind: "error", reason: "api-rejected", status: response.status };
    }
    const envelope = responseEnvelopeSchema(z.object({ removed: z.boolean() })).safeParse(await response.json());
    if (!envelope.success || !envelope.data.data?.removed) {
      return { kind: "error", reason: "invalid-payload" };
    }
    return { kind: "deleted" };
  } catch {
    return { kind: "error", reason: "api-unreachable" };
  }
}

export type AuditListFailureReason = "api-unconfigured" | "api-rejected" | "api-unreachable" | "invalid-payload" | "forbidden";

export type AuditListResult =
  | { kind: "ready"; data: AuditEventListPage; requestId: string }
  | { kind: "error"; reason: AuditListFailureReason; status?: number };

export type AuditListOptions = {
  actor?: string;
  action?: string;
  projectId?: string;
  limit?: number;
  offset?: number;
};

/**
 * Fetch the audit event history. The public response shape is metadata-stripped
 * by API contract, so the web layer never sees secret keys, fingerprints, or
 * other sensitive detail — only the safe event envelope (id, actor, action,
 * target, requestId, correlationId, timestamp).
 *
 * A 403 from the API (e.g. a read-only session) is surfaced as the
 * `forbidden` reason so the UI can render an actionable empty state instead
 * of collapsing it into a generic error.
 */
export async function loadAuditEvents(options: LoadAuthSessionOptions & AuditListOptions): Promise<AuditListResult> {
  if (!options.apiBaseUrl) return { kind: "error", reason: "api-unconfigured" };
  const url = new URL(metadataApiPaths.auditEvents, options.apiBaseUrl);
  if (options.actor) url.searchParams.set("actor", options.actor);
  if (options.action) url.searchParams.set("action", options.action);
  if (options.projectId) url.searchParams.set("projectId", options.projectId);
  if (options.limit !== undefined) url.searchParams.set("limit", String(options.limit));
  if (options.offset !== undefined) url.searchParams.set("offset", String(options.offset));
  try {
    const response = await (options.fetchImpl ?? fetch)(url.toString(), {
      ...createAuthApiRequest({ method: "GET" }),
      headers: { cookie: options.cookieHeader ?? "" }
    });
    if (response.status === 403) {
      return { kind: "error", reason: "forbidden", status: 403 };
    }
    if (!response.ok) {
      return { kind: "error", reason: "api-rejected", status: response.status };
    }
    return parseApiEnvelope(await response.json(), auditEventListPageSchema);
  } catch (error) {
    if (error instanceof z.ZodError) return { kind: "error", reason: "invalid-payload" };
    return { kind: "error", reason: "api-unreachable" };
  }
}

export function hasSessionCookie(cookieHeader: string | undefined, cookieName = defaultSessionCookieName): boolean {
  return (cookieHeader ?? "")
    .split(";")
    .map((part) => part.trim())
    .some((part) => part.startsWith(`${cookieName}=`) && part.slice(cookieName.length + 1).length > 0);
}

export function resolveAuthBoundary(user: SafeAuthUserDto | null, reason: AuthBoundaryReason = "missing-cookie"): AuthBoundaryState {
  return user ? { kind: "authenticated", user } : { kind: "unauthenticated", reason };
}

export async function loadAuthSession(options: LoadAuthSessionOptions): Promise<AuthBoundaryState> {
  if (!hasSessionCookie(options.cookieHeader)) {
    return resolveAuthBoundary(null, "missing-cookie");
  }

  if (!options.apiBaseUrl) {
    return resolveAuthBoundary(null, "api-unconfigured");
  }

  try {
    const response = await (options.fetchImpl ?? fetch)(createAuthApiUrl(authApiPaths.me, options.apiBaseUrl), {
      ...createAuthApiRequest({ method: "GET" }),
      headers: { cookie: options.cookieHeader ?? "" }
    });

    if (!response.ok) {
      return resolveAuthBoundary(null, "api-rejected");
    }

    const envelope = (await response.json()) as ApiEnvelope<AuthResponse>;
    const data = authResponseSchema.safeParse(envelope.data);
    return data.success ? resolveAuthBoundary(data.data.user) : resolveAuthBoundary(null, "api-rejected");
  } catch {
    return resolveAuthBoundary(null, "api-unreachable");
  }
}

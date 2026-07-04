import {
  agentSchema,
  authResponseSchema,
  deploymentSchema,
  logEventSchema,
  projectSchema,
  responseEnvelopeSchema,
  type Agent,
  type AuthResponse,
  type Deployment,
  type LogEvent,
  type Project,
  type SafeAuthUserDto
} from "@deploylite/contracts";
import { z } from "zod";

export const authApiPaths = {
  login: "/api/v1/auth/login",
  me: "/api/v1/auth/me",
  logout: "/api/v1/auth/logout"
} as const;

export const metadataApiPaths = {
  agents: "/api/v1/agents",
  projects: "/api/v1/projects",
  deployments: "/api/v1/deployments",
  deployment: (deploymentId: string) => `/api/v1/deployments/${encodeURIComponent(deploymentId)}`,
  deploymentLogs: (deploymentId: string) => `/api/v1/deployments/${encodeURIComponent(deploymentId)}/logs`
} as const;

export const defaultSessionCookieName = "deploylite_session";

export type AuthBoundaryReason = "missing-cookie" | "api-unconfigured" | "api-rejected" | "api-unreachable";

export type AuthBoundaryState =
  | { kind: "authenticated"; user: SafeAuthUserDto }
  | { kind: "unauthenticated"; reason: AuthBoundaryReason };

export type MetadataApiFailureReason = "api-unconfigured" | "api-rejected" | "api-unreachable" | "invalid-payload";

export type MetadataApiResult<Data> =
  | { kind: "ready"; data: Data; requestId: string }
  | { kind: "error"; reason: MetadataApiFailureReason; status?: number };

export type DashboardMetadata = {
  agents: Agent[];
  projects: Project[];
  deployments: Deployment[];
};

export type DeploymentLogMetadata = {
  deployment: Deployment | null;
  events: LogEvent[];
};

export type AuthApiRequestOptions = {
  method: "GET" | "POST";
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

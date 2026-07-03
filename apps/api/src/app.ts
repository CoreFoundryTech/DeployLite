import { createAuditLogRecord, createCorrelationContext, createRequestId } from "@deploylite/config";
import {
  agentRegistrationSchema,
  deploymentSchema,
  projectSchema,
  resourceSnapshotSchema,
  type Agent,
  type Deployment,
  type Project
} from "@deploylite/contracts";
import { AgentStatusService, InMemoryAgentRepository, InMemoryDeploymentRepository } from "@deploylite/domain";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";

declare module "fastify" {
  interface FastifyRequest {
    correlationContext: { requestId: string; correlationId: string };
  }
}

const API_PREFIX = "/api/v1";
const AUTH_HEADER = "x-scaffold-auth";
const SCAFFOLD_ACTOR = "scaffold-user";
const protectedAuthMessage = "Scaffold-only auth required; this is not production authentication.";

type ApiEnvelope<Data> = {
  data: Data | null;
  error: { code: string; message: string; correlationId: string } | null;
  requestId: string;
};

class InMemoryProjectRepository {
  readonly #projects = new Map<string, Project>();

  async save(project: Project): Promise<Project> {
    this.#projects.set(project.id, structuredClone(project));
    return project;
  }

  async list(): Promise<Project[]> {
    return [...this.#projects.values()];
  }
}

function ok<Data>(request: FastifyRequest, data: Data): ApiEnvelope<Data> {
  return { data, error: null, requestId: request.correlationContext.requestId };
}

function errorEnvelope(request: FastifyRequest, code: string, message: string): ApiEnvelope<never> {
  return {
    data: null,
    error: { code, message, correlationId: request.correlationContext.correlationId },
    requestId: request.correlationContext.requestId
  };
}

function getHeaderValue(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

async function requireScaffoldAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (getHeaderValue(request, AUTH_HEADER) !== "scaffold-dev") {
    void reply.code(401).send(errorEnvelope(request, "UNAUTHENTICATED", protectedAuthMessage));
  }
}

function createApiState() {
  const agents = new InMemoryAgentRepository();
  const deployments = new InMemoryDeploymentRepository();
  const projects = new InMemoryProjectRepository();
  const agentStatus = new AgentStatusService(agents);
  return { agents, deployments, projects, agentStatus };
}

type ApiState = ReturnType<typeof createApiState>;

async function seedMockData(state: ApiState): Promise<void> {
  const startedAt = "2026-01-01T00:00:00.000Z";
  await state.agents.save({
    id: "agent_mock_1",
    name: "Mock VPS Agent",
    endpoint: "https://agent.example.test",
    status: "online",
    lastHeartbeatAt: startedAt,
    resourceSnapshot: { cpuLoad: 0.24, memoryUsedBytes: 512, memoryTotalBytes: 2048, diskUsedBytes: 10_000, diskTotalBytes: 100_000 }
  });
  await state.projects.save({
    id: "project_mock_1",
    name: "DeployLite Mock Project",
    repoUrl: "https://github.com/CoreFoundryTech/DeployLite",
    defaultBranch: "main"
  });
  await state.deployments.save({
    id: "dep_mock_1",
    projectId: "project_mock_1",
    agentId: "agent_mock_1",
    status: "running",
    commitSha: "abcdef1",
    startedAt,
    finishedAt: null
  });
  await state.deployments.appendLog({
    id: "log_1",
    deploymentId: "dep_mock_1",
    sequence: 1,
    level: "info",
    message: "Preparing deployment",
    timestamp: startedAt,
    redactionApplied: false,
    requestId: "seed_req_1",
    correlationId: "seed_req_1"
  });
  await state.deployments.appendLog({
    id: "log_2",
    deploymentId: "dep_mock_1",
    sequence: 2,
    level: "info",
    message: "Using token dl_1234567890abcdef for mock fixture",
    timestamp: "2026-01-01T00:00:01.000Z",
    redactionApplied: false,
    requestId: "seed_req_1",
    correlationId: "seed_req_1"
  });
}

function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  return schema.parse(body);
}

function auditMutation(request: FastifyRequest, action: string, targetType: string, targetId: string) {
  return createAuditLogRecord({ actorId: SCAFFOLD_ACTOR, action, targetType, targetId, ...request.correlationContext });
}

function registerCoreHooks(app: FastifyInstance): void {
  app.addHook("onRequest", async (request) => {
    const inboundRequestId = getHeaderValue(request, "x-request-id");
    const requestId = inboundRequestId && inboundRequestId.trim().length > 0 ? inboundRequestId : createRequestId();
    request.correlationContext = createCorrelationContext(requestId);
  });
  app.addHook("onSend", async (request, reply) => {
    reply.header("x-request-id", request.correlationContext.requestId);
    reply.header("x-correlation-id", request.correlationContext.correlationId);
  });
  app.setErrorHandler((error, request, reply) => {
    const isValidationError = error instanceof z.ZodError;
    void reply
      .code(isValidationError ? 400 : 500)
      .send(errorEnvelope(request, isValidationError ? "VALIDATION_ERROR" : "INTERNAL_ERROR", isValidationError ? "Request validation failed." : "Unexpected server error."));
  });
}

function registerRoutes(app: FastifyInstance, state: ApiState): void {
  app.get(`${API_PREFIX}/health`, async (request) => ok(request, { status: "ok", service: "deploylite-api", auth: "scaffold-only" }));
  app.post(`${API_PREFIX}/auth/login`, async (request) =>
    ok(request, { actorId: SCAFFOLD_ACTOR, mode: "scaffold-only", message: "Use x-scaffold-auth: scaffold-dev for protected mock routes. Not production auth." })
  );
  app.get(`${API_PREFIX}/auth/me`, { preHandler: requireScaffoldAuth }, async (request) =>
    ok(request, { id: SCAFFOLD_ACTOR, email: "operator@example.test", role: "owner", status: "active" })
  );
  app.post(`${API_PREFIX}/agents/register`, { preHandler: requireScaffoldAuth }, async (request) => {
    const body = parseBody(agentRegistrationSchema, request.body);
    const agent: Agent = { id: `agent_${createRequestId()}`, name: body.name, endpoint: body.endpoint, status: "offline", lastHeartbeatAt: null, resourceSnapshot: null };
    await state.agents.save(agent);
    return ok(request, { agent, audit: auditMutation(request, "agent.register", "agent", agent.id) });
  });
  app.post(`${API_PREFIX}/agents/:agentId/heartbeat`, { preHandler: requireScaffoldAuth }, async (request) => {
    const params = z.object({ agentId: z.string().min(1) }).parse(request.params);
    const body = z.object({ observedAt: z.string().datetime({ offset: true }), resourceSnapshot: resourceSnapshotSchema }).parse(request.body);
    const agent = await state.agentStatus.recordHeartbeat({ agentId: params.agentId, observedAt: body.observedAt, resourceSnapshot: body.resourceSnapshot, ...request.correlationContext });
    return ok(request, { agent, audit: auditMutation(request, "agent.heartbeat", "agent", agent.id) });
  });
  app.get(`${API_PREFIX}/agents`, { preHandler: requireScaffoldAuth }, async (request) => {
    const agents = (await state.agents.list()).map((agent) => state.agentStatus.markStale(agent));
    return ok(request, { agents });
  });
  app.get(`${API_PREFIX}/projects`, { preHandler: requireScaffoldAuth }, async (request) => ok(request, { projects: await state.projects.list() }));
  app.post(`${API_PREFIX}/projects`, { preHandler: requireScaffoldAuth }, async (request) => {
    const body = parseBody(projectSchema.omit({ id: true }), request.body);
    const project = await state.projects.save({ id: `project_${createRequestId()}`, ...body });
    return ok(request, { project, audit: auditMutation(request, "project.create", "project", project.id) });
  });
  app.get(`${API_PREFIX}/deployments/:deploymentId`, { preHandler: requireScaffoldAuth }, async (request, reply) => {
    const params = z.object({ deploymentId: z.string().min(1) }).parse(request.params);
    const deployment = await state.deployments.findById(params.deploymentId);
    return deployment ? ok(request, { deployment }) : reply.code(404).send(errorEnvelope(request, "NOT_FOUND", "Deployment not found."));
  });
  app.get(`${API_PREFIX}/deployments/:deploymentId/logs/stream`, { preHandler: requireScaffoldAuth }, async (request, reply) => {
    const params = z.object({ deploymentId: z.string().min(1) }).parse(request.params);
    const lastEventId = Number.parseInt(getHeaderValue(request, "last-event-id") ?? "-1", 10);
    const logs = await state.deployments.listLogs(params.deploymentId, Number.isFinite(lastEventId) ? lastEventId : -1);
    const body = logs
      .map((log) => `id: ${log.sequence}\nevent: deployment.log\ndata: ${JSON.stringify({ ...log, audit: { action: "deployment.log.stream", targetType: "deployment", targetId: params.deploymentId, ...request.correlationContext } })}\n`)
      .join("\n");
    return reply.header("content-type", "text/event-stream; charset=utf-8").header("cache-control", "no-cache").send(body.length > 0 ? `${body}\n` : "");
  });
  app.post(`${API_PREFIX}/deployments`, { preHandler: requireScaffoldAuth }, async (request) => {
    const body = parseBody(deploymentSchema.omit({ id: true, startedAt: true, finishedAt: true }), request.body);
    const deployment: Deployment = { id: `dep_${createRequestId()}`, startedAt: new Date().toISOString(), finishedAt: null, ...body };
    await state.deployments.save(deployment);
    return ok(request, { deployment, audit: auditMutation(request, "deployment.create", "deployment", deployment.id) });
  });
}

export async function buildApiApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const state = createApiState();
  await seedMockData(state);
  registerCoreHooks(app);
  registerRoutes(app, state);
  return app;
}

export { API_PREFIX, AUTH_HEADER };

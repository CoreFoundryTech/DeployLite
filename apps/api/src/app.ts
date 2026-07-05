import { createAuditLogRecord, createCorrelationContext, createRequestId, parseDeployLiteEnv, type DeployLiteEnv } from "@deploylite/config";
import {
  agentRegistrationSchema,
  authLoginRequestSchema,
  bootstrapInitialAdminRequestSchema,
  deployRequestSchema,
  deploymentSchema,
  envVariableMetadataSchema,
  envVariableMetadataUpsertRequestSchema,
  projectCreateRequestSchema,
  projectSchema,
  projectUpdateRequestSchema,
  resourceSnapshotSchema,
  type Agent,
  type Deployment,
  type EnvVariableMetadata,
  type Project
} from "@deploylite/contracts";
import { BcryptPasswordHasher, bootstrapInitialAdmin, closeDbPool, createDbClient, createDbPool, createOpaqueSessionToken, DbAgentRepository, DbAuditRepository, DbAuthUserRepository, DbDeploymentRepository, DbEnvVariableMetadataRepository, DbProjectRepository, DbSessionRepository, hashSessionToken, type DeployLiteDb } from "@deploylite/db";
import {
  AgentStatusService,
  authenticateLocalUser,
  getBootstrapStatus,
  InMemoryAgentRepository,
  InMemoryDeploymentRepository,
  InMemoryEnvVariableMetadataRepository,
  InitialAdminAlreadyExistsError,
  toSafeAuthUser,
  type AuditEvent,
  type AuditEventInput,
  type AuditRepository,
  type AuthSession,
  type AuthUser,
  type AuthUserRepository,
  type CanonicalRoleName,
  type CreateInitialAdminInput,
  type CreateSessionInput,
  type EnvVariableMetadataRepository,
  type PasswordHasher,
  type AgentRepository,
  type DeploymentRepository,
  type ProjectRepository,
  type SafeAuthUser,
  type SessionRepository
} from "@deploylite/domain";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";

declare module "fastify" {
  interface FastifyRequest {
    correlationContext: { requestId: string; correlationId: string };
    auth?: AuthContext;
  }
}

const API_PREFIX = "/api/v1";
const AUTH_HEADER = "x-scaffold-auth";
const SCAFFOLD_ACTOR = "scaffold-user";
const defaultSessionCookieName = "deploylite_session";
const authRequiredMessage = "Authentication required.";

type ApiEnvelope<Data> = {
  data: Data | null;
  error: { code: string; message: string; correlationId: string } | null;
  requestId: string;
};

class InMemoryProjectRepository implements ProjectRepository {
  readonly #projects = new Map<string, Project>();

  async save(project: Project): Promise<Project> {
    const cloned = structuredClone(project);
    this.#projects.set(project.id, cloned);
    return cloned;
  }

  async findById(id: string): Promise<Project | null> {
    const existing = this.#projects.get(id);
    return existing ? structuredClone(existing) : null;
  }

  async list(): Promise<Project[]> {
    return [...this.#projects.values()].map((project) => structuredClone(project));
  }

  async remove(id: string): Promise<boolean> {
    return this.#projects.delete(id);
  }
}

type AuthContext = {
  user: SafeAuthUser;
  session: AuthSession;
};

type AuthConfig = {
  cookieName: string;
  cookieSecure: boolean;
  sessionTtlSeconds: number;
};

type AuthAdapters = {
  audit: AuditRepository;
  hasher: PasswordHasher;
  sessions: SessionRepository;
  users: AuthUserRepository;
};

type DbPool = Parameters<typeof closeDbPool>[0];

type ApiRepositories = {
  auth: AuthAdapters;
  state: PlatformRepositories;
  shouldSeedMockData: boolean;
  close?: () => Promise<void>;
};

type BuildApiAppOptions = {
  auth?: Partial<AuthAdapters>;
  authConfig?: Partial<AuthConfig>;
  corsOrigin?: string | false;
  state?: Partial<PlatformRepositoryOptions>;
  db?: {
    pool?: DbPool;
    client?: DeployLiteDb;
    createPool?: (connectionString: string) => DbPool;
    closePool?: (pool: DbPool) => Promise<void>;
  };
  env?: NodeJS.ProcessEnv;
};

class InMemoryAuthUserRepository implements AuthUserRepository {
  readonly #users = new Map<string, AuthUser>();

  constructor(seed: AuthUser[] = []) {
    for (const user of seed) {
      this.#users.set(user.id, structuredClone(user));
    }
  }

  async findByEmail(email: string): Promise<AuthUser | null> {
    const normalized = normalizeEmail(email);
    return [...this.#users.values()].find((user) => user.emailNormalized === normalized) ?? null;
  }

  async findById(id: string): Promise<AuthUser | null> {
    return this.#users.get(id) ?? null;
  }

  async count(): Promise<number> {
    return this.#users.size;
  }

  async createInitialAdmin(input: CreateInitialAdminInput): Promise<AuthUser> {
    if (this.#users.size > 0) {
      throw new InitialAdminAlreadyExistsError();
    }
    const now = new Date();
    const user: AuthUser = {
      id: `user_${createRequestId()}`,
      email: input.email,
      emailNormalized: normalizeEmail(input.email),
      passwordHash: input.passwordHash,
      role: "admin",
      status: "active",
      createdAt: now,
      updatedAt: now
    };
    this.#users.set(user.id, structuredClone(user));
    return user;
  }
}

class InMemorySessionRepository implements SessionRepository {
  readonly #sessions = new Map<string, AuthSession>();

  async create(input: CreateSessionInput): Promise<AuthSession> {
    const now = new Date();
    const session: AuthSession = {
      id: `session_${createRequestId()}`,
      userId: input.userId,
      tokenHash: input.tokenHash,
      expiresAt: input.expiresAt,
      revokedAt: null,
      ipHash: input.ipHash ?? null,
      userAgent: input.userAgent ?? null,
      createdAt: now,
      lastSeenAt: now
    };
    this.#sessions.set(session.id, structuredClone(session));
    return session;
  }

  async findValidByTokenHash(tokenHash: string, now = new Date()): Promise<AuthSession | null> {
    return [...this.#sessions.values()].find((session) => session.tokenHash === tokenHash && session.revokedAt === null && session.expiresAt.getTime() > now.getTime()) ?? null;
  }

  async revoke(sessionId: string, now = new Date()): Promise<AuthSession | null> {
    const session = this.#sessions.get(sessionId);
    if (!session) {
      return null;
    }
    const revoked = { ...session, revokedAt: now };
    this.#sessions.set(sessionId, revoked);
    return revoked;
  }
}

class InMemoryAuditRepository implements AuditRepository {
  readonly events: AuditEvent[] = [];
  readonly inputs: AuditEventInput[] = [];

  async append(input: AuditEventInput): Promise<AuditEvent> {
    const safe = createAuditLogRecord({
      actorId: input.actorUserId === null ? "anonymous" : input.actorUserId ?? "system",
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId,
      requestId: input.requestId,
      correlationId: input.correlationId,
      metadata: input.metadata
    });
    const event: AuditEvent = {
      id: `audit_${createRequestId()}`,
      actorId: safe.actorId,
      action: safe.action,
      targetType: safe.targetType,
      targetId: safe.targetId,
      requestId: safe.requestId,
      correlationId: safe.correlationId,
      timestamp: safe.timestamp
    };
    this.inputs.push({ ...input, metadata: safe.metadata });
    this.events.push(event);
    return event;
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

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function toSafeAuthDto(user: SafeAuthUser) {
  return { id: user.id, email: user.email, role: user.role, status: user.status };
}

function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) {
    return {};
  }
  return Object.fromEntries(
    header
      .split(";")
      .map((part) => part.trim().split("="))
      .filter(([name, value]) => name && value)
      .map(([name, value]) => [name, decodeURIComponent(value ?? "")])
  );
}

function sessionCookie(config: AuthConfig, token: string, maxAge: number): string {
  const secure = config.cookieSecure ? "; Secure" : "";
  return `${config.cookieName}=${encodeURIComponent(token)}; Max-Age=${maxAge}; Path=/; HttpOnly; SameSite=Lax${secure}`;
}

async function appendAudit(audit: AuditRepository, request: FastifyRequest, input: Omit<AuditEventInput, "requestId" | "correlationId">): Promise<AuditEvent> {
  return audit.append({ ...input, ...request.correlationContext });
}

function createAuthPreHandler(adapters: AuthAdapters, config: AuthConfig) {
  return async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const token = parseCookies(getHeaderValue(request, "cookie"))[config.cookieName];
    if (!token) {
      await appendAudit(adapters.audit, request, { action: "protected.denied", targetType: "route", targetId: request.url, metadata: { reason: "missing-session" } });
      void reply.code(401).send(errorEnvelope(request, "UNAUTHENTICATED", authRequiredMessage));
      return;
    }

    const session = await adapters.sessions.findValidByTokenHash(hashSessionToken(token));
    const user = session ? await adapters.users.findById(session.userId) : null;
    if (!session || !user || user.status !== "active") {
      await appendAudit(adapters.audit, request, {
        actorUserId: user?.id ?? null,
        action: "protected.denied",
        targetType: "route",
        targetId: request.url,
        metadata: { reason: !session ? "invalid-session" : "disabled-user" }
      });
      void reply.code(401).send(errorEnvelope(request, "UNAUTHENTICATED", authRequiredMessage));
      return;
    }

    request.auth = { user: toSafeAuthUser(user), session };
  };
}

function createRolePreHandler(adapters: AuthAdapters, roles: readonly CanonicalRoleName[]) {
  return async function requireRole(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (!request.auth) {
      return;
    }
    if (!roles.includes(request.auth.user.role)) {
      await appendAudit(adapters.audit, request, {
        actorUserId: request.auth.user.id,
        action: "protected.denied",
        targetType: "route",
        targetId: request.url,
        metadata: { reason: "insufficient-role", role: request.auth.user.role, allowedRoles: [...roles] }
      });
      void reply.code(403).send(errorEnvelope(request, "FORBIDDEN", "Insufficient role for this action."));
    }
  };
}

type PlatformRepositoryOptions = {
  agents: AgentRepository;
  deployments: DeploymentRepository;
  projects: ProjectRepository;
  envMetadata?: EnvVariableMetadataRepository;
};

type PlatformRepositories = PlatformRepositoryOptions & {
  agentStatus: AgentStatusService;
  envMetadata: EnvVariableMetadataRepository;
  deployRunner: DeployRunner;
};

function createApiState(overrides: Partial<PlatformRepositoryOptions> = {}): PlatformRepositories {
  const agents = overrides.agents ?? new InMemoryAgentRepository();
  const deployments = overrides.deployments ?? new InMemoryDeploymentRepository();
  const projects = overrides.projects ?? new InMemoryProjectRepository();
  const envMetadata = overrides.envMetadata ?? new InMemoryEnvVariableMetadataRepository();
  const agentStatus = new AgentStatusService(agents);
  const deployRunner = new DeployRunner(deployments, envMetadata, agentStatus);
  return { agents, deployments, projects, envMetadata, agentStatus, deployRunner };
}

class DeployRunner {
  #sequenceByDeployment = new Map<string, number>();
  #timers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly deployments: DeploymentRepository,
    private readonly envMetadata: EnvVariableMetadataRepository,
    private readonly agentStatus: AgentStatusService
  ) {}

  /**
   * Control-plane deployment runner. In this local MVP, the API does not talk
   * to a real agent or to a Docker socket. It records the deployment as
   * `queued`, then schedules status transitions to `running` and `succeeded`
   * (or `failed` when required env metadata is missing) and appends audit-safe
   * log events so the UI can show a real lifecycle end-to-end.
   */
  async start(deployment: Deployment, project: Project, requestId: string, correlationId: string): Promise<{ deployment: Deployment; logs: EnvVariableMetadata[] }> {
    const logs = await this.envMetadata.listByProject(project.id);
    const missingRequired = logs.filter((record) => record.required && !record.valuePresent);
    await this.appendLog(deployment, "info", `Queued deploy for project ${project.name} (${project.repoUrl}@${project.defaultBranch}).`, requestId, correlationId);
    await this.appendLog(deployment, "info", `Resolved ${logs.length} env metadata record(s); ${missingRequired.length} required-without-value.`, requestId, correlationId);

    if (missingRequired.length > 0) {
      await this.appendLog(deployment, "error", `Refusing to advance: required env metadata missing for ${missingRequired.map((m) => m.key).join(", ")}.`, requestId, correlationId);
      const failed: Deployment = { ...deployment, status: "failed", finishedAt: new Date().toISOString() };
      await this.deployments.save(failed);
      return { deployment: failed, logs };
    }

    if (!project.buildCommand) {
      await this.appendLog(deployment, "warn", "No build command configured; skipping build step.", requestId, correlationId);
    } else {
      await this.appendLog(deployment, "info", `Build command: ${project.buildCommand}`, requestId, correlationId);
    }
    if (!project.runCommand) {
      await this.appendLog(deployment, "warn", "No run command configured; deploy will stay in queued state.", requestId, correlationId);
    } else {
      await this.appendLog(deployment, "info", `Run command: ${project.runCommand} (port ${project.port ?? "default"})`, requestId, correlationId);
    }

    this.scheduleAdvance(deployment.id, "running", 50);
    this.scheduleAdvance(deployment.id, "succeeded", 250);
    return { deployment, logs };
  }

  async appendLog(deployment: Deployment, level: "debug" | "info" | "warn" | "error", message: string, requestId: string, correlationId: string) {
    const next = (this.#sequenceByDeployment.get(deployment.id) ?? 0) + 1;
    this.#sequenceByDeployment.set(deployment.id, next);
    await this.deployments.appendLog({
      id: `log_${createRequestId()}`,
      deploymentId: deployment.id,
      sequence: next,
      level,
      message,
      timestamp: new Date().toISOString(),
      redactionApplied: true,
      requestId,
      correlationId
    });
  }

  scheduleAdvance(deploymentId: string, status: "running" | "succeeded" | "failed", delayMs: number) {
    const previous = this.#timers.get(deploymentId);
    if (previous) {
      clearTimeout(previous);
    }
    const timer = setTimeout(async () => {
      this.#timers.delete(deploymentId);
      const existing = await this.deployments.findById(deploymentId);
      if (!existing) return;
      if (existing.status === "failed" || existing.status === "succeeded" || existing.status === "canceled") return;
      const finishedAt = status === "running" ? null : new Date().toISOString();
      const next: Deployment = { ...existing, status, finishedAt };
      await this.deployments.save(next);
      const message =
        status === "running"
          ? "Simulated agent picked up the deployment. Real Docker execution is intentionally deferred."
          : status === "succeeded"
            ? "Simulated agent marked the deployment succeeded. Real container execution is intentionally deferred."
            : "Simulated agent marked the deployment failed.";
      await this.appendLog(next, status === "succeeded" ? "info" : status === "failed" ? "error" : "info", message, next.startedAt, next.startedAt);
      void this.agentStatus;
    }, delayMs);
    this.#timers.set(deploymentId, timer);
  }

  cancelTimers() {
    for (const timer of this.#timers.values()) {
      clearTimeout(timer);
    }
    this.#timers.clear();
  }
}

async function createSeededInMemoryAuthAdapters(env: DeployLiteEnv): Promise<AuthAdapters> {
  const hasher = new BcryptPasswordHasher(env.DEPLOYLITE_BCRYPT_COST);
  const adminHash = await hasher.hash("deploylite-admin-password");
  return {
    audit: new InMemoryAuditRepository(),
    hasher,
    sessions: new InMemorySessionRepository(),
    users: new InMemoryAuthUserRepository([
      {
        id: "user_admin_1",
        email: "admin@example.test",
        emailNormalized: "admin@example.test",
        passwordHash: adminHash,
        role: "admin",
        status: "active",
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        updatedAt: new Date("2026-01-01T00:00:00.000Z")
      }
    ])
  };
}

function createDbAuthAdapters(env: DeployLiteEnv, options: BuildApiAppOptions): ApiRepositories {
  const pool = options.db?.pool ?? (options.db?.createPool ?? createDbPool)(env.DATABASE_URL!);
  const db = options.db?.client ?? createDbClient(pool);
  const closePool = options.db?.closePool ?? closeDbPool;

  return {
    auth: {
      audit: new DbAuditRepository(db),
      hasher: new BcryptPasswordHasher(env.DEPLOYLITE_BCRYPT_COST),
      sessions: new DbSessionRepository(db),
      users: new DbAuthUserRepository(db)
    },
    close: options.db?.pool ? undefined : () => closePool(pool),
    shouldSeedMockData: false,
    state: createApiState({
      agents: options.state?.agents ?? new DbAgentRepository(db),
      deployments: options.state?.deployments ?? new DbDeploymentRepository(db),
      projects: options.state?.projects ?? new DbProjectRepository(db),
      envMetadata: options.state?.envMetadata ?? new DbEnvVariableMetadataRepository(db)
    })
  };
}

async function createRuntimeRepositories(env: DeployLiteEnv, options: BuildApiAppOptions = {}): Promise<ApiRepositories> {
  if (env.DATABASE_URL) {
    const repositories = createDbAuthAdapters(env, options);
    return { ...repositories, auth: { ...repositories.auth, ...options.auth } };
  }

  return {
    auth: { ...(await createSeededInMemoryAuthAdapters(env)), ...options.auth },
    shouldSeedMockData: true,
    state: createApiState(options.state)
  };
}

async function seedMockData(state: PlatformRepositories): Promise<void> {
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
    defaultBranch: "main",
    buildCommand: "pnpm build",
    runCommand: "pnpm start",
    port: 3000,
    description: null
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
  return createAuditLogRecord({ actorId: request.auth?.user.id ?? SCAFFOLD_ACTOR, action, targetType, targetId, ...request.correlationContext });
}

function isAllowedCorsRequest(request: FastifyRequest, corsOrigin: string | null): boolean {
  return Boolean(corsOrigin && getHeaderValue(request, "origin") === corsOrigin);
}

function registerCoreHooks(app: FastifyInstance, corsOrigin: string | null): void {
  app.addHook("onRequest", async (request) => {
    const inboundRequestId = getHeaderValue(request, "x-request-id");
    const requestId = inboundRequestId && inboundRequestId.trim().length > 0 ? inboundRequestId : createRequestId();
    request.correlationContext = createCorrelationContext(requestId);
  });
  app.addHook("onSend", async (request, reply) => {
    if (isAllowedCorsRequest(request, corsOrigin)) {
      reply.header("access-control-allow-origin", corsOrigin);
      reply.header("access-control-allow-credentials", "true");
      reply.header("vary", "Origin");
    }
    reply.header("x-request-id", request.correlationContext.requestId);
    reply.header("x-correlation-id", request.correlationContext.correlationId);
  });
  if (corsOrigin) {
    app.options("/*", async (request, reply) => {
      if (!isAllowedCorsRequest(request, corsOrigin)) {
        return reply.header("vary", "Origin").code(204).send();
      }

      return reply
        .header("access-control-allow-origin", corsOrigin)
        .header("access-control-allow-credentials", "true")
        .header("access-control-allow-headers", "content-type,x-request-id")
        .header("access-control-allow-methods", "GET,POST,PATCH,DELETE,OPTIONS")
        .header("vary", "Origin")
        .code(204)
        .send();
    });
  }
  app.setErrorHandler((error, request, reply) => {
    const isValidationError = error instanceof z.ZodError;
    void reply
      .code(isValidationError ? 400 : 500)
      .send(errorEnvelope(request, isValidationError ? "VALIDATION_ERROR" : "INTERNAL_ERROR", isValidationError ? "Request validation failed." : "Unexpected server error."));
  });
}

function registerRoutes(app: FastifyInstance, state: PlatformRepositories, adapters: AuthAdapters, authConfig: AuthConfig): void {
  const requireAuth = createAuthPreHandler(adapters, authConfig);
  const requireMutationRole = createRolePreHandler(adapters, ["admin", "operator"]);

  app.get(`${API_PREFIX}/health`, async (request) => ok(request, { status: "ok", service: "deploylite-api", auth: "cookie-session" }));
  app.get(`${API_PREFIX}/bootstrap/status`, async (request) => ok(request, await getBootstrapStatus(adapters.users)));
  app.post(`${API_PREFIX}/bootstrap/initial-admin`, async (request, reply) => {
    const parsed = bootstrapInitialAdminRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      await appendAudit(adapters.audit, request, { action: "bootstrap.initial-admin.rejected", targetType: "user", targetId: "initial-admin", metadata: { reason: "invalid-input" } });
      return reply.code(400).send(errorEnvelope(request, "VALIDATION_ERROR", "Request validation failed."));
    }

    const result = await bootstrapInitialAdmin(adapters.users, adapters.hasher, parsed.data);
    if (!result.created || !result.user) {
      await appendAudit(adapters.audit, request, { action: "bootstrap.initial-admin.rejected", targetType: "user", targetId: "initial-admin", metadata: { reason: "locked" } });
      return reply.code(409).send(errorEnvelope(request, "BOOTSTRAP_LOCKED", "Initial admin setup is no longer available."));
    }

    await appendAudit(adapters.audit, request, { actorUserId: null, action: "bootstrap.initial-admin", targetType: "user", targetId: result.user.id });
    return ok(request, { user: toSafeAuthDto(result.user) });
  });
  app.post(`${API_PREFIX}/auth/login`, async (request, reply) => {
    const body = parseBody(authLoginRequestSchema, request.body);
    const user = await authenticateLocalUser(adapters.users, adapters.hasher, body.email, body.password);
    if (!user) {
      await appendAudit(adapters.audit, request, { action: "auth.login.failed", targetType: "user", targetId: normalizeEmail(body.email), metadata: { email: normalizeEmail(body.email), password: body.password } });
      return reply.code(401).send(errorEnvelope(request, "UNAUTHENTICATED", "Invalid email or password."));
    }

    const token = createOpaqueSessionToken(authConfig.sessionTtlSeconds);
    const session = await adapters.sessions.create({ userId: user.id, tokenHash: token.tokenHash, expiresAt: token.expiresAt, userAgent: getHeaderValue(request, "user-agent") ?? null });
    await appendAudit(adapters.audit, request, { actorUserId: user.id, action: "auth.login.succeeded", targetType: "session", targetId: session.id, metadata: { role: user.role } });
    return reply.header("set-cookie", sessionCookie(authConfig, token.token, authConfig.sessionTtlSeconds)).send(ok(request, { user: toSafeAuthDto(user) }));
  });
  app.get(`${API_PREFIX}/auth/me`, { preHandler: requireAuth }, async (request) => ok(request, { user: toSafeAuthDto(request.auth!.user) }));
  app.post(`${API_PREFIX}/auth/logout`, { preHandler: requireAuth }, async (request, reply) => {
    await adapters.sessions.revoke(request.auth!.session.id);
    await appendAudit(adapters.audit, request, { actorUserId: request.auth!.user.id, action: "auth.logout", targetType: "session", targetId: request.auth!.session.id });
    return reply.header("set-cookie", sessionCookie(authConfig, "", 0)).send(ok(request, { loggedOut: true }));
  });
  app.post(`${API_PREFIX}/agents/register`, { preHandler: [requireAuth, requireMutationRole] }, async (request) => {
    const body = parseBody(agentRegistrationSchema, request.body);
    const agent: Agent = { id: `agent_${createRequestId()}`, name: body.name, endpoint: body.endpoint, status: "offline", lastHeartbeatAt: null, resourceSnapshot: null };
    await state.agents.save(agent);
    return ok(request, { agent, audit: auditMutation(request, "agent.register", "agent", agent.id) });
  });
  app.post(`${API_PREFIX}/agents/:agentId/heartbeat`, { preHandler: [requireAuth, requireMutationRole] }, async (request) => {
    const params = z.object({ agentId: z.string().min(1) }).parse(request.params);
    const body = z.object({ observedAt: z.string().datetime({ offset: true }), resourceSnapshot: resourceSnapshotSchema }).parse(request.body);
    const agent = await state.agentStatus.recordHeartbeat({ agentId: params.agentId, observedAt: body.observedAt, resourceSnapshot: body.resourceSnapshot, ...request.correlationContext });
    return ok(request, { agent, audit: auditMutation(request, "agent.heartbeat", "agent", agent.id) });
  });
  app.get(`${API_PREFIX}/agents`, { preHandler: requireAuth }, async (request) => {
    const agents = (await state.agents.list()).map((agent) => state.agentStatus.markStale(agent));
    return ok(request, { agents });
  });
  app.get(`${API_PREFIX}/projects`, { preHandler: requireAuth }, async (request) => ok(request, { projects: await state.projects.list() }));
  app.post(`${API_PREFIX}/projects`, { preHandler: [requireAuth, requireMutationRole] }, async (request) => {
    const body = parseBody(projectCreateRequestSchema, request.body);
    const project: Project = {
      id: `project_${createRequestId()}`,
      name: body.name,
      repoUrl: body.repoUrl,
      defaultBranch: body.defaultBranch,
      buildCommand: body.buildCommand ?? null,
      runCommand: body.runCommand ?? null,
      port: body.port ?? null,
      description: body.description ?? null
    };
    const saved = await state.projects.save(project);
    return ok(request, { project: saved, audit: auditMutation(request, "project.create", "project", saved.id) });
  });
  app.get(`${API_PREFIX}/projects/:projectId`, { preHandler: requireAuth }, async (request, reply) => {
    const params = z.object({ projectId: z.string().min(1) }).parse(request.params);
    const project = await state.projects.findById(params.projectId);
    return project ? ok(request, { project }) : reply.code(404).send(errorEnvelope(request, "NOT_FOUND", "Project not found."));
  });
  app.patch(`${API_PREFIX}/projects/:projectId`, { preHandler: [requireAuth, requireMutationRole] }, async (request, reply) => {
    const params = z.object({ projectId: z.string().min(1) }).parse(request.params);
    const existing = await state.projects.findById(params.projectId);
    if (!existing) {
      return reply.code(404).send(errorEnvelope(request, "NOT_FOUND", "Project not found."));
    }
    const body = parseBody(projectUpdateRequestSchema, request.body);
    const next: Project = {
      ...existing,
      name: body.name ?? existing.name,
      repoUrl: body.repoUrl ?? existing.repoUrl,
      defaultBranch: body.defaultBranch ?? existing.defaultBranch,
      buildCommand: body.buildCommand !== undefined ? (body.buildCommand ?? null) : existing.buildCommand,
      runCommand: body.runCommand !== undefined ? (body.runCommand ?? null) : existing.runCommand,
      port: body.port !== undefined ? (body.port ?? null) : existing.port,
      description: body.description !== undefined ? (body.description ?? null) : existing.description
    };
    const saved = await state.projects.save(next);
    return ok(request, { project: saved, audit: auditMutation(request, "project.update", "project", saved.id) });
  });
  app.delete(`${API_PREFIX}/projects/:projectId`, { preHandler: [requireAuth, requireMutationRole] }, async (request, reply) => {
    const params = z.object({ projectId: z.string().min(1) }).parse(request.params);
    const existing = await state.projects.findById(params.projectId);
    if (!existing) {
      return reply.code(404).send(errorEnvelope(request, "NOT_FOUND", "Project not found."));
    }
    const removed = await state.projects.remove(params.projectId);
    if (!removed) {
      return reply.code(404).send(errorEnvelope(request, "NOT_FOUND", "Project not found."));
    }
    await appendAudit(adapters.audit, request, { actorUserId: request.auth?.user.id ?? null, action: "project.delete", targetType: "project", targetId: params.projectId });
    return ok(request, { removed: true, audit: auditMutation(request, "project.delete", "project", params.projectId) });
  });
  app.get(`${API_PREFIX}/projects/:projectId/env-variables`, { preHandler: requireAuth }, async (request, reply) => {
    const params = z.object({ projectId: z.string().min(1) }).parse(request.params);
    const project = await state.projects.findById(params.projectId);
    if (!project) {
      return reply.code(404).send(errorEnvelope(request, "NOT_FOUND", "Project not found."));
    }
    const records = await state.envMetadata.listByProject(params.projectId);
    return ok(request, { envVariables: records.map((record) => envVariableMetadataSchema.parse(record)) });
  });
  app.post(`${API_PREFIX}/projects/:projectId/env-variables`, { preHandler: [requireAuth, requireMutationRole] }, async (request, reply) => {
    const params = z.object({ projectId: z.string().min(1) }).parse(request.params);
    const project = await state.projects.findById(params.projectId);
    if (!project) {
      return reply.code(404).send(errorEnvelope(request, "NOT_FOUND", "Project not found."));
    }
    const body = parseBody(envVariableMetadataUpsertRequestSchema, request.body);
    const now = new Date().toISOString();
    const record: EnvVariableMetadata = {
      id: `env_${createRequestId()}`,
      projectId: params.projectId,
      key: body.key,
      scope: body.scope ?? "project",
      valuePresent: false,
      valueFingerprint: null,
      required: body.required ?? false,
      description: body.description ?? null,
      updatedAt: now
    };
    const saved = await state.envMetadata.upsert(record);
    return ok(request, { envVariable: envVariableMetadataSchema.parse(saved), audit: auditMutation(request, "project.env.upsert", "project", params.projectId) });
  });
  app.delete(`${API_PREFIX}/projects/:projectId/env-variables`, { preHandler: [requireAuth, requireMutationRole] }, async (request, reply) => {
    const params = z.object({ projectId: z.string().min(1), key: z.string().min(1), scope: z.enum(["project", "deployment"]).default("project") })
      .parse({ ...(request.params as Record<string, string>), scope: (request.query as { scope?: string } | undefined)?.scope ?? "project" });
    const removed = await state.envMetadata.remove(params.projectId, params.key, params.scope);
    return removed
      ? ok(request, { removed: true, audit: auditMutation(request, "project.env.delete", "project", params.projectId) })
      : reply.code(404).send(errorEnvelope(request, "NOT_FOUND", "Env metadata not found."));
  });
  app.post(`${API_PREFIX}/projects/:projectId/deployments`, { preHandler: [requireAuth, requireMutationRole] }, async (request, reply) => {
    const params = z.object({ projectId: z.string().min(1) }).parse(request.params);
    const project = await state.projects.findById(params.projectId);
    if (!project) {
      return reply.code(404).send(errorEnvelope(request, "NOT_FOUND", "Project not found."));
    }
    const body = parseBody(deployRequestSchema, request.body ?? {});
    let agentId = body.agentId ?? null;
    if (!agentId) {
      const onlineAgents = (await state.agents.list()).filter((agent) => agent.status === "online" || agent.status === "stale");
      agentId = onlineAgents[0]?.id ?? null;
    }
    if (!agentId) {
      return reply.code(409).send(errorEnvelope(request, "NO_AGENT_AVAILABLE", "No agent is online. Register an agent or bring one online before deploying."));
    }
    const commitSha = body.commitSha ?? "0000000";
    const deployment: Deployment = {
      id: `dep_${createRequestId()}`,
      projectId: project.id,
      agentId,
      status: "queued",
      commitSha,
      startedAt: new Date().toISOString(),
      finishedAt: null
    };
    await state.deployments.save(deployment);
    const runnerResult = await state.deployRunner.start(deployment, project, request.correlationContext.requestId, request.correlationContext.correlationId);
    return ok(request, {
      deployment: runnerResult.deployment,
      envVariables: runnerResult.logs.map((record) => envVariableMetadataSchema.parse(record)),
      audit: auditMutation(request, "deployment.trigger", "deployment", deployment.id)
    });
  });
  app.get(`${API_PREFIX}/deployments/:deploymentId`, { preHandler: requireAuth }, async (request, reply) => {
    const params = z.object({ deploymentId: z.string().min(1) }).parse(request.params);
    const deployment = await state.deployments.findById(params.deploymentId);
    return deployment ? ok(request, { deployment }) : reply.code(404).send(errorEnvelope(request, "NOT_FOUND", "Deployment not found."));
  });
  app.get(`${API_PREFIX}/deployments`, { preHandler: requireAuth }, async (request) => ok(request, { deployments: await state.deployments.list() }));
  app.get(`${API_PREFIX}/deployments/:deploymentId/logs`, { preHandler: requireAuth }, async (request) => {
    const params = z.object({ deploymentId: z.string().min(1) }).parse(request.params);
    return ok(request, { events: await state.deployments.listLogs(params.deploymentId) });
  });
  app.get(`${API_PREFIX}/deployments/:deploymentId/logs/stream`, { preHandler: requireAuth }, async (request, reply) => {
    const params = z.object({ deploymentId: z.string().min(1) }).parse(request.params);
    const lastEventId = Number.parseInt(getHeaderValue(request, "last-event-id") ?? "-1", 10);
    const logs = await state.deployments.listLogs(params.deploymentId, Number.isFinite(lastEventId) ? lastEventId : -1);
    const body = logs
      .map((log) => `id: ${log.sequence}\nevent: deployment.log\ndata: ${JSON.stringify({ ...log, audit: { action: "deployment.log.stream", targetType: "deployment", targetId: params.deploymentId, ...request.correlationContext } })}\n`)
      .join("\n");
    return reply.header("content-type", "text/event-stream; charset=utf-8").header("cache-control", "no-cache").send(body.length > 0 ? `${body}\n` : "");
  });
  app.post(`${API_PREFIX}/deployments`, { preHandler: [requireAuth, requireMutationRole] }, async (request) => {
    const body = parseBody(deploymentSchema.omit({ id: true, startedAt: true, finishedAt: true }), request.body);
    const deployment: Deployment = { id: `dep_${createRequestId()}`, startedAt: new Date().toISOString(), finishedAt: null, ...body };
    await state.deployments.save(deployment);
    return ok(request, { deployment, audit: auditMutation(request, "deployment.create", "deployment", deployment.id) });
  });
}

export async function buildApiApp(options: BuildApiAppOptions = {}): Promise<FastifyInstance> {
  const env = parseDeployLiteEnv(options.env ?? process.env);
  const app = Fastify({ logger: false });
  const corsOrigin = options.corsOrigin === false ? null : options.corsOrigin ?? env.DEPLOYLITE_CORS_ORIGIN ?? (env.NODE_ENV === "production" ? null : "http://localhost:3000");
  const authConfig: AuthConfig = {
    cookieName: env.DEPLOYLITE_SESSION_COOKIE_NAME ?? defaultSessionCookieName,
    cookieSecure: env.DEPLOYLITE_SESSION_COOKIE_SECURE ?? env.NODE_ENV === "production",
    sessionTtlSeconds: env.DEPLOYLITE_SESSION_TTL_SECONDS,
    ...options.authConfig
  };
  const repositories = await createRuntimeRepositories(env, options);
  if (repositories.close) {
    app.addHook("onClose", repositories.close);
  }
  if (repositories.shouldSeedMockData) {
    await seedMockData(repositories.state);
  }
  registerCoreHooks(app, corsOrigin);
  registerRoutes(app, repositories.state, repositories.auth, authConfig);
  app.addHook("onClose", () => {
    repositories.state.deployRunner.cancelTimers();
  });
  return app;
}

export { API_PREFIX, AUTH_HEADER, InMemoryAuditRepository, InMemoryAuthUserRepository, InMemorySessionRepository, createRuntimeRepositories, type ApiRepositories, type BuildApiAppOptions };

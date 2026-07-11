import { createAuditLogRecord, createCorrelationContext, createRequestId, parseDeployLiteEnv, type DeployLiteEnv, createEnvSecretCipher, EnvSecretCipherError, EnvSecretKeyInvalidError, EnvSecretKeyMissingError, ENCRYPTION_KEY_VERSION, loadEnvSecretKey, redactLogMessage, redactSecrets, type EnvSecretCipher } from "@deploylite/config";
import {
  agentRegistrationSchema,
  agentSelfHeartbeatSchema,
  agentSelfRegistrationSchema,
  authLoginRequestSchema,
  bootstrapInitialAdminRequestSchema,
  deployRequestSchema,
  deploymentSchema,
  envSecretValueDeleteRequestSchema,
  envSecretValueSchema,
  envSecretValueWriteRequestSchema,
  envVariableMetadataSchema,
  envVariableMetadataUpsertRequestSchema,
  projectCreateRequestSchema,
  projectSchema,
  projectUpdateRequestSchema,
  resourceSnapshotSchema,
  type Agent,
  type Deployment,
  type DeploymentCommand,
  type EnvSecretValue,
  type EnvVariableMetadata,
  type Project
} from "@deploylite/contracts";
import { BcryptPasswordHasher, bootstrapInitialAdmin, closeDbPool, createDbClient, createDbPool, createOpaqueSessionToken, DbAgentRepository, DbAuditRepository, DbAuthUserRepository, DbDeploymentCommandRepository, DbDeploymentRepository, DbEnvSecretValueRepository, DbEnvVariableMetadataRepository, DbProjectRepository, DbSessionRepository, hashSessionToken, type DeployLiteDb } from "@deploylite/db";
import {
  AgentStatusService,
  buildDeployEnvFile,
  deploymentContainerName,
  redactEnvFileForLog,
  authenticateLocalUser,
  getBootstrapStatus,
  InMemoryAgentRepository,
  InMemoryDeploymentCommandRepository,
  InMemoryDeploymentRepository,
  InMemoryEnvSecretValueRepository,
  InMemoryEnvVariableMetadataRepository,
  InitialAdminAlreadyExistsError,
  toSafeAuthUser,
  type AuditEvent,
  type AuditEventInput,
  type AuditEventListItem,
  type AuditRepository,
  type AuthSession,
  type AuthUser,
  type AuthUserRepository,
  type CanonicalRoleName,
  type CreateInitialAdminInput,
  type CreateSessionInput,
  type DeploymentCommandBus,
  type DeploymentCommandRepository,
  type EnvSecretValueRepository,
  type EnvSecretMaterializationRepository,
  type EnvVariableMetadataRepository,
  type PasswordHasher,
  type AgentRepository,
  type DeploymentExecutor,
  type DeploymentRepository,
  type ProjectRepository,
  type SafeAuthUser,
  type SessionRepository
} from "@deploylite/domain";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { DeploymentCommandBusService, MockDeploymentExecutor } from "./commands/index.js";

declare module "fastify" {
  interface FastifyRequest {
    correlationContext: { requestId: string; correlationId: string };
    auth?: AuthContext;
  }
}

const API_PREFIX = "/api/v1";
const SSE_LOG_PAGE_LIMIT = 100;
const SSE_POLL_INTERVAL_MS = 1_000;
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
  now?: () => Date;
  commandReconciliationIntervalMs?: number;
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

  async list(filter: { actorUserId?: string; action?: string; projectId?: string; limit?: number; offset?: number } = {}): Promise<{ events: AuditEventListItem[]; total: number; limit: number; offset: number }> {
    const limit = clampListLimit(filter.limit);
    const offset = clampListOffset(filter.offset);
    // Mirror the DB behavior: order by timestamp desc so the most recent
    // event appears first. The DB uses `desc(auditEvents.createdAt)`; the
    // in-memory mirror sorts by the same field exposed on the API surface
    // (`timestamp`).
    const sorted = [...this.events].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    const filtered = sorted.filter((event) => matchesAuditFilter(event, this.inputs, filter));
    return {
      events: filtered.slice(offset, offset + limit).map(toAuditListItem),
      total: filtered.length,
      limit,
      offset
    };
  }
}

const MAX_AUDIT_LIST_LIMIT = 200;
const DEFAULT_AUDIT_LIST_LIMIT = 50;
const MAX_AUDIT_LIST_OFFSET = 10_000;

type AuditListFilter = {
  actorUserId?: string;
  action?: string;
  projectId?: string;
  limit?: number;
  offset?: number;
};

function clampListLimit(raw: number | undefined): number {
  if (raw === undefined) return DEFAULT_AUDIT_LIST_LIMIT;
  if (!Number.isInteger(raw) || raw < 1) return 1;
  if (raw > MAX_AUDIT_LIST_LIMIT) return MAX_AUDIT_LIST_LIMIT;
  return raw;
}

function clampListOffset(raw: number | undefined): number {
  if (raw === undefined) return 0;
  if (!Number.isInteger(raw) || raw < 0) return 0;
  if (raw > MAX_AUDIT_LIST_OFFSET) return MAX_AUDIT_LIST_OFFSET;
  return raw;
}

function toAuditListItem(event: AuditEvent): AuditEventListItem {
  return {
    id: event.id,
    actorId: event.actorId,
    action: event.action,
    targetType: event.targetType,
    targetId: event.targetId,
    requestId: event.requestId,
    correlationId: event.correlationId,
    timestamp: event.timestamp
  };
}

function matchesAuditFilter(event: AuditEvent, inputs: AuditEventInput[], filter: AuditListFilter): boolean {
  if (filter.actorUserId) {
    // Mirror the DB behavior: exact match on the persisted actor id. The
    // API surface resolves null/missing actor to "anonymous" / "system"
    // on the response, but the filter is applied against the raw
    // `event.actorId` (which is what the DB's `actorUserId` column would
    // round-trip to). A `?actor=system` query therefore matches only the
    // rows that were written with that literal placeholder; the in-memory
    // path used to fold anonymous/system in unconditionally, which
    // diverged from the DB and inflated counts.
    if (event.actorId !== filter.actorUserId) {
      return false;
    }
  }
  if (filter.action && !event.action.startsWith(filter.action)) {
    return false;
  }
  if (filter.projectId) {
    const prefix = `${filter.projectId}:`;
    const matchesTargetPrefix = event.targetId === filter.projectId || event.targetId.startsWith(prefix);
    if (matchesTargetPrefix) {
      return true;
    }
    // Fall back to the metadata.projectId mirror so events whose targetId is
    // opaque (e.g. an env_secret_values row id) still get filtered correctly.
    const input = inputs.find((candidate) => candidate.requestId === event.requestId && candidate.correlationId === event.correlationId);
    if (!input || !input.metadata || (input.metadata as Record<string, unknown>)["projectId"] !== filter.projectId) {
      return false;
    }
  }
  return true;
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
  deploymentCommands?: DeploymentCommandRepository;
  envMetadata?: EnvVariableMetadataRepository;
  envSecretValues?: EnvSecretValueRepository;
  envSecretMaterialization?: EnvSecretMaterializationRepository;
  envSecretCipher?: EnvSecretCipher;
};

type PlatformRepositories = PlatformRepositoryOptions & {
  agentStatus: AgentStatusService;
  envMetadata: EnvVariableMetadataRepository;
  envSecretValues: EnvSecretValueRepository;
  envSecretMaterialization: EnvSecretMaterializationRepository;
  envSecretCipher: EnvSecretCipher;
  deploymentCommandBus: DeploymentCommandBus;
  deploymentExecutor: DeploymentExecutor;
  cancelDeploymentExecutorTimers: () => void;
  externalAgentIdentity: { agentId: string; token: string } | null;
  now: () => Date;
};

type EnvSecretKeySource = NodeJS.ProcessEnv | Record<string, string | number | boolean | undefined>;

function extractSecretKey(env: EnvSecretKeySource): string | undefined {
  const value = (env as Record<string, unknown>)["DEPLOYLITE_SECRET_KEY"];
  return typeof value === "string" ? value : undefined;
}

function createLazyEnvSecretCipher(env: EnvSecretKeySource): EnvSecretCipher {
  const loadCipher = () => createEnvSecretCipher(loadEnvSecretKey(extractSecretKey(env)));
  return {
    encrypt: (plaintext) => loadCipher().encrypt(plaintext),
    decrypt: (ciphertext) => loadCipher().decrypt(ciphertext),
    fingerprint: (plaintext) => loadCipher().fingerprint(plaintext)
  };
}

function createApiState(env: EnvSecretKeySource, overrides: Partial<PlatformRepositoryOptions> = {}, now: () => Date = () => new Date()): PlatformRepositories {
  const agents = overrides.agents ?? new InMemoryAgentRepository();
  const deployments = overrides.deployments ?? new InMemoryDeploymentRepository();
  const projects = overrides.projects ?? new InMemoryProjectRepository();
  const deploymentCommands = overrides.deploymentCommands ?? new InMemoryDeploymentCommandRepository();
  const envMetadata = overrides.envMetadata ?? new InMemoryEnvVariableMetadataRepository();
  const envSecretValues = overrides.envSecretValues ?? new InMemoryEnvSecretValueRepository();
  const envSecretMaterialization = overrides.envSecretMaterialization ?? asEnvSecretMaterializationRepository(envSecretValues);
  const envSecretCipher = overrides.envSecretCipher ?? createLazyEnvSecretCipher(env);
  const agentId = typeof env["DEPLOYLITE_AGENT_ID"] === "string" ? env["DEPLOYLITE_AGENT_ID"] : undefined;
  const agentToken = typeof env["DEPLOYLITE_AGENT_TOKEN"] === "string" ? env["DEPLOYLITE_AGENT_TOKEN"] : undefined;
  if (agentId || agentToken) loadEnvSecretKey(extractSecretKey(env));
  const agentStatus = new AgentStatusService(agents);

  // The deployment command bus is the in-process control-plane channel
  // between the API route handlers and the deployment executor. The
  // executor is the only component allowed to mutate the deployment
  // status, append deployment logs, or touch the host. Slice 1 keeps
  // the executor in the API process so the route surface stays
  // socket-free; a later slice will replace the in-process executor
  // with a real agent that runs in a Docker-socket-mounted container.
  const deploymentCommandBus = new DeploymentCommandBusService(deploymentCommands, now);
  const deploymentExecutor = new MockDeploymentExecutor({
    bus: deploymentCommandBus,
    deployments,
    envMetadata,
    agentStatus,
    envSecretCipher,
    projectResolver: (projectId) => projects.findById(projectId)
  });
  deploymentCommandBus.registerExecutor(deploymentExecutor);

  const state: PlatformRepositories = {
    agents,
    deployments,
    projects,
    deploymentCommands,
    envMetadata,
    envSecretValues,
    envSecretMaterialization,
    envSecretCipher,
    agentStatus,
    deploymentCommandBus,
    deploymentExecutor,
    cancelDeploymentExecutorTimers: () => deploymentExecutor.cancelTimers(),
    externalAgentIdentity: agentId && agentToken ? { agentId, token: agentToken } : null,
    now
  };
  deploymentCommandBus.onEvent(async (event) => {
    if (event.type === "deployment.command.cancelled") await projectAuthoritativeTerminalCommand(state, event.command);
  });
  return state;
}

function asEnvSecretMaterializationRepository(repository: EnvSecretValueRepository): EnvSecretMaterializationRepository {
  const candidate = repository as EnvSecretValueRepository & Partial<EnvSecretMaterializationRepository>;
  if (typeof candidate.listEncryptedByProject === "function") {
    return { listEncryptedByProject: (projectId) => candidate.listEncryptedByProject!(projectId) };
  }
  return {
    async listEncryptedByProject() {
      throw new EnvSecretKeyMissingError("encrypted env material repository is unavailable");
    }
  };
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
    state: createApiState(env, {
      agents: options.state?.agents ?? new DbAgentRepository(db),
      deployments: options.state?.deployments ?? new DbDeploymentRepository(db),
      projects: options.state?.projects ?? new DbProjectRepository(db),
      deploymentCommands: options.state?.deploymentCommands ?? new DbDeploymentCommandRepository(db),
      envMetadata: options.state?.envMetadata ?? new DbEnvVariableMetadataRepository(db),
      envSecretValues: options.state?.envSecretValues ?? new DbEnvSecretValueRepository(db),
      envSecretMaterialization: options.state?.envSecretMaterialization,
      envSecretCipher: options.state?.envSecretCipher
    }, options.now)
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
    state: createApiState(env, options.state, options.now)
  };
}

async function seedMockData(state: PlatformRepositories): Promise<void> {
  const startedAt = state.now().toISOString();
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
    description: null,
    imageTag: null
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

async function findEnvMetadata(
  repository: EnvVariableMetadataRepository,
  projectId: string,
  key: string,
  scope: EnvVariableMetadata["scope"]
): Promise<EnvVariableMetadata | null> {
  const records = await repository.listByProject(projectId);
  return records.find((record) => record.key === key && record.scope === scope) ?? null;
}

async function findEnvSecretValue(
  repository: EnvSecretValueRepository,
  projectId: string,
  key: string,
  scope: EnvVariableMetadata["scope"]
): Promise<EnvSecretValue | null> {
  const records = await repository.listByProject(projectId);
  return records.find((record) => record.key === key && record.scope === scope) ?? null;
}

const agentIdSchema = z.string().uuid();
const commandIdSchema = z.string().uuid();
const agentClaimBodySchema = z.object({ agentId: agentIdSchema }).strict();
const agentCompleteBodySchema = z.object({ output: z.record(z.unknown()).optional() }).strict();
const agentFailBodySchema = z.object({ reason: z.string().min(1).max(1024) }).strict();
const INVALID_COMMAND_REASON_MAX = 256;
const MAX_AGENT_OBSERVED_SKEW_MS = 60_000;

class InvalidCommandPrerequisiteError extends Error {}

function authenticateAgentRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  identity: PlatformRepositories["externalAgentIdentity"]
): identity is NonNullable<PlatformRepositories["externalAgentIdentity"]> {
  const authorization = getHeaderValue(request, "authorization");
  if (!authorization?.startsWith("Bearer ")) {
    void reply.code(401).send(errorEnvelope(request, "AGENT_AUTH_REQUIRED", "Agent authentication required."));
    return false;
  }
  if (!identity || !constantTimeEqual(authorization.slice(7), identity.token)) {
    void reply.code(403).send(errorEnvelope(request, "AGENT_AUTH_INVALID", "Agent authentication failed."));
    return false;
  }
  return true;
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftDigest = createHash("sha256").update(left).digest();
  const rightDigest = createHash("sha256").update(right).digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

async function materializeAgentExecutionInput(
  state: PlatformRepositories,
  command: DeploymentCommand
): Promise<{
  command: DeploymentCommand;
  repoUrl: string;
  ref: string;
  projectSlug: string;
  envFile: { contents: string };
  healthUrl: string;
} | null> {
  if (command.kind !== "start" || (command.state !== "pending" && command.state !== "claimed")) {
    throw new InvalidCommandPrerequisiteError("Deployment command has an unsupported execution prerequisite.");
  }
  const deployment = await state.deployments.findById(command.deploymentId);
  if (!deployment) throw new InvalidCommandPrerequisiteError("Linked deployment is missing.");
  if (deployment.agentId !== command.agentId) throw new InvalidCommandPrerequisiteError("Deployment agent assignment does not match the command.");
  const project = await state.projects.findById(deployment.projectId);
  if (!project) throw new InvalidCommandPrerequisiteError("Linked project is missing.");
  if (!project.repoUrl) throw new InvalidCommandPrerequisiteError("Project repository is missing.");
  if (!deployment.commitSha) throw new InvalidCommandPrerequisiteError("Deployment revision is missing.");
  if (!Number.isInteger(project.port) || project.port === null || project.port < 1 || project.port > 65_535) {
    throw new InvalidCommandPrerequisiteError("Project port is missing or invalid.");
  }
  const metadata = await state.envMetadata.listByProject(project.id);
  const encrypted = await state.envSecretMaterialization.listEncryptedByProject(project.id);
  const materializedKeys = new Set(encrypted.map((record) => `${record.scope}:${record.key}`));
  if (metadata.some((record) => record.required && !materializedKeys.has(`${record.scope}:${record.key}`))) {
    throw new InvalidCommandPrerequisiteError("A required deployment secret is unavailable.");
  }
  let envFile;
  try {
    envFile = buildDeployEnvFile(encrypted, state.envSecretCipher);
  } catch (error) {
    if (error instanceof EnvSecretKeyMissingError || error instanceof EnvSecretKeyInvalidError || error instanceof EnvSecretCipherError) {
      throw new InvalidCommandPrerequisiteError("Deployment secret material cannot be decrypted.");
    }
    throw error;
  }
  return {
    command,
    repoUrl: project.repoUrl,
    ref: deployment.commitSha,
    projectSlug: project.id,
    envFile: { contents: envFile.contents },
    healthUrl: `http://${deploymentContainerName(project.id, command.id)}:${project.port}/`
  };
}

async function projectAuthoritativeTerminalCommand(
  state: PlatformRepositories,
  command: DeploymentCommand,
  failedLifecycle?: { marker: string; message: string }
): Promise<void> {
  if (!(await state.deployments.findById(command.deploymentId))) return;
  if (command.state === "completed") {
    await ensureAgentDeploymentLifecycle(state, command, { status: "succeeded", level: "info", marker: "Agent completed deployment command", message: "Agent completed deployment command; deployment succeeded." });
  } else if (command.state === "failed") {
    const fallback = `Agent command failed: ${redactLogMessage(command.failureReason ?? "Unknown failure").slice(0, INVALID_COMMAND_REASON_MAX)}`;
    await ensureAgentDeploymentLifecycle(state, command, {
      status: "failed",
      level: "error",
      marker: failedLifecycle?.marker ?? "Agent command failed",
      message: failedLifecycle?.message ?? fallback
    });
  } else if (command.state === "cancelled") {
    await ensureAgentDeploymentLifecycle(state, command, {
      status: "canceled",
      level: "error",
      marker: "Deployment command cancelled",
      message: "Deployment command cancelled; deployment was canceled."
    });
  }
}

async function terminallyFailAgentCommand(state: PlatformRepositories, command: DeploymentCommand, reason: string, marker = "Agent command rejected"): Promise<DeploymentCommand | null> {
  const safeReason = redactLogMessage(reason).slice(0, INVALID_COMMAND_REASON_MAX);
  const authoritative = await state.deploymentCommandBus.failSystem(command.id, safeReason);
  if (authoritative) await projectAuthoritativeTerminalCommand(state, authoritative, { marker, message: `${marker}: ${safeReason}` });
  return authoritative;
}

async function terminallyExpireAgentCommand(state: PlatformRepositories, command: DeploymentCommand, reason: string, marker: string): Promise<DeploymentCommand | null> {
  const safeReason = redactLogMessage(reason).slice(0, INVALID_COMMAND_REASON_MAX);
  const authoritative = await state.deploymentCommandBus.failExpiredClaim(command.id, safeReason);
  if (authoritative && authoritative.state !== "claimed") {
    await projectAuthoritativeTerminalCommand(state, authoritative, { marker, message: `${marker}: ${safeReason}` });
  }
  return authoritative;
}

async function reconcileExpiredClaims(state: PlatformRepositories, agentId: string): Promise<void> {
  const now = state.now().getTime();
  const assigned = (await state.deploymentCommandBus.list()).filter((command) => command.agentId === agentId);
  const claimed = assigned.filter((command) => command.state === "claimed");
  for (const command of claimed) {
    if (!command.leaseExpiresAt || new Date(command.leaseExpiresAt).getTime() <= now) {
      await terminallyExpireAgentCommand(state, command, "Agent command lease expired; execution was not retried.", "Agent command lease expired");
    }
  }
  for (const command of assigned) {
    if (command.state === "failed" && command.failureReason?.includes("lease expired")) {
      await projectAuthoritativeTerminalCommand(state, command, {
        marker: "Agent command lease expired",
        message: `Agent command lease expired: ${redactLogMessage(command.failureReason).slice(0, INVALID_COMMAND_REASON_MAX)}`
      });
    }
    if (command.state === "cancelled") await projectAuthoritativeTerminalCommand(state, command);
  }
}

type AgentDeploymentLifecycle = {
  status: "running" | "succeeded" | "failed" | "canceled";
  level: "info" | "error";
  marker: string;
  message: string;
};

async function ensureAgentDeploymentLifecycle(
  state: PlatformRepositories,
  command: DeploymentCommand,
  lifecycle: AgentDeploymentLifecycle
): Promise<void> {
  const deployment = await state.deployments.findById(command.deploymentId);
  if (!deployment || deployment.agentId !== command.agentId) throw new Error("Linked deployment is unavailable for agent lifecycle update");
  const terminal = lifecycle.status === "succeeded" || lifecycle.status === "failed" || lifecycle.status === "canceled";
  const startedAt = lifecycle.status === "running" ? deployment.startedAt ?? state.now().toISOString() : deployment.startedAt;
  const nextDeployment = {
    ...deployment,
    status: lifecycle.status,
    startedAt,
    finishedAt: terminal ? deployment.finishedAt ?? command.completedAt ?? state.now().toISOString() : null
  };
  const needsSave = deployment.status !== lifecycle.status || deployment.startedAt !== startedAt || (terminal && !deployment.finishedAt);

  const logs = await state.deployments.listLogs(deployment.id);
  const correlated = (message: string, requestId: string, correlationId: string) =>
    requestId === command.requestId && correlationId === command.correlationId && message.startsWith(lifecycle.marker);
  const appendLifecycleLog = async () => {
    if (logs.some((log) => correlated(log.message, log.requestId, log.correlationId))) return;
    const event = {
      id: createRequestId(),
      deploymentId: deployment.id,
      level: lifecycle.level,
      message: lifecycle.message,
      timestamp: command.completedAt ?? state.now().toISOString(),
      redactionApplied: true,
      requestId: command.requestId,
      correlationId: command.correlationId
    } as const;
    try {
      await state.deployments.appendAllocatedLog(event);
    } catch (error) {
      const current = await state.deployments.listLogs(deployment.id);
      if (!current.some((log) => correlated(log.message, log.requestId, log.correlationId))) throw error;
    }
  };

  // A terminal status makes SSE consumers eligible to close. Persist the
  // correlated lifecycle log first so a terminal frame can never overtake it.
  if (terminal) {
    await appendLifecycleLog();
    if (needsSave) await state.deployments.save(nextDeployment);
    return;
  }
  if (needsSave) await state.deployments.save(nextDeployment);
  await appendLifecycleLog();
}

async function compensateAgentLifecycleFailure(state: PlatformRepositories, command: DeploymentCommand): Promise<void> {
  const reason = "Deployment lifecycle persistence failed after the agent command transition";
  try {
    await terminallyFailAgentCommand(state, command, reason, "Agent lifecycle persistence failed");
  } catch { /* best-effort compensation only; the original request reports the repository failure */ }
}

/**
 * Resolve the complete ownership chain before exposing deployment state or
 * accepting a lifecycle request. Deployment rows are never trusted on their
 * own: their project and assigned agent must still exist and agree with the
 * command/control-plane binding.
 */
async function resolveDeploymentScope(state: PlatformRepositories, deploymentId: string) {
  const deployment = await state.deployments.findById(deploymentId);
  if (!deployment) return null;
  const [project, agent] = await Promise.all([
    state.projects.findById(deployment.projectId),
    state.agents.findById(deployment.agentId)
  ]);
  if (!project || !agent || agent.id !== deployment.agentId) return null;
  if (state.externalAgentIdentity && agent.id !== state.externalAgentIdentity.agentId) return null;
  return { deployment, project, agent };
}

async function appendDeploymentControlLog(
  state: PlatformRepositories,
  deploymentId: string,
  level: "info" | "warn" | "error",
  message: string,
  request: FastifyRequest
): Promise<void> {
  const existing = await state.deployments.listLogs(deploymentId);
  if (existing.some((event) => event.message === redactLogMessage(message))) return;
  await state.deployments.appendAllocatedLog({
    id: createRequestId(),
    deploymentId,
    level,
    message: redactLogMessage(message),
    timestamp: state.now().toISOString(),
    redactionApplied: true,
    ...request.correlationContext
  });
}

function sseResumeCursor(request: FastifyRequest): number {
  const raw = getHeaderValue(request, "last-event-id");
  if (!raw || !/^\d{1,15}$/.test(raw)) return -1;
  const cursor = Number.parseInt(raw, 10);
  return Number.isSafeInteger(cursor) ? cursor : -1;
}

async function reconcileCancelledDeployment(state: PlatformRepositories, command: DeploymentCommand, request: FastifyRequest): Promise<void> {
  await appendDeploymentControlLog(state, command.deploymentId, "info", "Deployment cancellation requested by an authorized operator.", request);
  await projectAuthoritativeTerminalCommand(state, command);
}

async function assignedCommand(state: PlatformRepositories, commandId: string, agentId: string): Promise<DeploymentCommand | null> {
  const command = await state.deploymentCommandBus.findById(commandId);
  return command?.agentId === agentId ? command : null;
}

function hasAcceptableAgentClockSkew(observedAt: string, receivedAt: Date): boolean {
  return Math.abs(new Date(observedAt).getTime() - receivedAt.getTime()) <= MAX_AGENT_OBSERVED_SKEW_MS;
}

function terminalConflictResponse(request: FastifyRequest, command: DeploymentCommand, attemptedState: "completed" | "failed") {
  return {
    data: { authoritativeCommand: command, attemptedState },
    error: {
      code: "AUTHORITATIVE_TERMINAL_CONFLICT",
      message: "The command already has a different authoritative terminal outcome.",
      correlationId: request.correlationContext.correlationId
    },
    requestId: request.correlationContext.requestId
  };
}

function leaseConflictResponse(request: FastifyRequest, command: DeploymentCommand, attemptedState: "completed" | "failed") {
  return {
    data: { authoritativeCommand: command, attemptedState, leaseConflict: true },
    error: {
      code: "AUTHORITATIVE_LEASE_CONFLICT",
      message: "The agent command lease was not live when the terminal transition committed.",
      correlationId: request.correlationContext.correlationId
    },
    requestId: request.correlationContext.requestId
  };
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
  // Audit history is an operator/admin concern. Read-only sessions are denied
  // by design so a passive role cannot enumerate every project + key change.
  const requireAuditReadRole = createRolePreHandler(adapters, ["admin", "operator"]);

  app.get(`${API_PREFIX}/health`, async (request) => ok(request, { status: "ok", service: "deploylite-api", auth: "cookie-session" }));
  app.post(`${API_PREFIX}/agent/register`, async (request, reply) => {
    if (!authenticateAgentRequest(request, reply, state.externalAgentIdentity)) return reply;
    const parsed = agentSelfRegistrationSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send(errorEnvelope(request, "VALIDATION_ERROR", "Invalid agent registration request."));
    if (parsed.data.agentId !== state.externalAgentIdentity.agentId) {
      return reply.code(403).send(errorEnvelope(request, "AGENT_IDENTITY_MISMATCH", "Agent identity mismatch."));
    }
    const receivedAt = state.now();
    if (!hasAcceptableAgentClockSkew(parsed.data.observedAt, receivedAt)) {
      return reply.code(400).send(errorEnvelope(request, "AGENT_CLOCK_SKEW", "Agent observedAt is outside the accepted clock-skew window."));
    }
    const existing = await state.agents.findById(parsed.data.agentId);
    const agent: Agent = {
      id: parsed.data.agentId,
      name: parsed.data.name,
      endpoint: parsed.data.endpoint,
      status: "online",
      lastHeartbeatAt: receivedAt.toISOString(),
      resourceSnapshot: parsed.data.resourceSnapshot
    };
    await state.agents.save(agent);
    return reply.code(existing ? 200 : 201).send(agent);
  });
  app.post(`${API_PREFIX}/agent/:agentId/heartbeat`, async (request, reply) => {
    if (!authenticateAgentRequest(request, reply, state.externalAgentIdentity)) return reply;
    const params = z.object({ agentId: agentIdSchema }).safeParse(request.params);
    const body = agentSelfHeartbeatSchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send(errorEnvelope(request, "VALIDATION_ERROR", "Invalid agent heartbeat request."));
    if (params.data.agentId !== state.externalAgentIdentity.agentId || body.data.agentId !== state.externalAgentIdentity.agentId) {
      return reply.code(403).send(errorEnvelope(request, "AGENT_IDENTITY_MISMATCH", "Agent identity mismatch."));
    }
    const receivedAt = state.now();
    if (!hasAcceptableAgentClockSkew(body.data.observedAt, receivedAt)) {
      return reply.code(400).send(errorEnvelope(request, "AGENT_CLOCK_SKEW", "Agent observedAt is outside the accepted clock-skew window."));
    }
    const existing = await state.agents.findById(params.data.agentId);
    if (!existing) return reply.code(404).send(errorEnvelope(request, "AGENT_NOT_REGISTERED", "Agent is not registered."));
    const agent = await state.agentStatus.recordHeartbeat({ ...body.data, ...request.correlationContext }, receivedAt);
    return reply.send(agent);
  });
  app.get(`${API_PREFIX}/agent/commands/next`, async (request, reply) => {
    if (!authenticateAgentRequest(request, reply, state.externalAgentIdentity)) return reply;
    const parsed = z.object({ agentId: agentIdSchema }).safeParse(request.query);
    if (!parsed.success) return reply.code(400).send(errorEnvelope(request, "VALIDATION_ERROR", "Invalid agent command request."));
    if (parsed.data.agentId !== state.externalAgentIdentity.agentId) {
      return reply.code(403).send(errorEnvelope(request, "AGENT_IDENTITY_MISMATCH", "Agent identity mismatch."));
    }
    if (!(await state.agents.findById(parsed.data.agentId))) return reply.code(204).send();
    await reconcileExpiredClaims(state, parsed.data.agentId);
    const commands = (await state.deploymentCommandBus.list())
      .filter((command) => command.agentId === parsed.data.agentId && command.state === "pending")
      .sort((left, right) => left.issuedAt.localeCompare(right.issuedAt));
    for (const command of commands) {
      try {
        const input = await materializeAgentExecutionInput(state, command);
        const claimed = await state.deploymentCommandBus.claim(command.id, parsed.data.agentId);
        if (claimed) {
          try {
            await ensureAgentDeploymentLifecycle(state, claimed, { status: "running", level: "info", marker: "Agent claimed deployment command", message: "Agent claimed deployment command; deployment is running." });
          } catch (error) {
            await compensateAgentLifecycleFailure(state, claimed);
            throw error;
          }
          return reply.send({ ...input, command: claimed });
        }
      } catch (error) {
        if (error instanceof InvalidCommandPrerequisiteError) {
          await terminallyFailAgentCommand(state, command, error.message);
          continue;
        }
        throw error;
      }
    }
    return reply.code(204).send();
  });
  app.get(`${API_PREFIX}/agent/commands/claimed`, async (request, reply) => {
    if (!authenticateAgentRequest(request, reply, state.externalAgentIdentity)) return reply;
    const parsed = z.object({ agentId: agentIdSchema }).safeParse(request.query);
    if (!parsed.success) return reply.code(400).send(errorEnvelope(request, "VALIDATION_ERROR", "Invalid agent command request."));
    if (parsed.data.agentId !== state.externalAgentIdentity.agentId) return reply.code(403).send(errorEnvelope(request, "AGENT_IDENTITY_MISMATCH", "Agent identity mismatch."));
    await reconcileExpiredClaims(state, parsed.data.agentId);
    const command = (await state.deploymentCommandBus.list()).find((item) => item.agentId === parsed.data.agentId && item.state === "claimed");
    if (!command) return reply.code(204).send();
    try {
      return reply.send(await materializeAgentExecutionInput(state, command));
    } catch (error) {
      if (error instanceof InvalidCommandPrerequisiteError) {
        await terminallyFailAgentCommand(state, command, error.message);
        return reply.code(204).send();
      }
      throw error;
    }
  });
  app.post(`${API_PREFIX}/agent/commands/:commandId/claim`, async (request, reply) => {
    if (!authenticateAgentRequest(request, reply, state.externalAgentIdentity)) return reply;
    const params = z.object({ commandId: commandIdSchema }).safeParse(request.params);
    const body = agentClaimBodySchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send(errorEnvelope(request, "VALIDATION_ERROR", "Invalid agent command request."));
    if (body.data.agentId !== state.externalAgentIdentity.agentId) return reply.code(403).send(errorEnvelope(request, "AGENT_IDENTITY_MISMATCH", "Agent identity mismatch."));
    const existing = await assignedCommand(state, params.data.commandId, state.externalAgentIdentity.agentId);
    if (!existing) return reply.code(404).send(errorEnvelope(request, "NOT_FOUND", "Command not found."));
    const claimed = existing.state === "claimed" ? existing : await state.deploymentCommandBus.claim(existing.id, state.externalAgentIdentity.agentId);
    if (!claimed) return reply.code(409).send(errorEnvelope(request, "COMMAND_STATE_CONFLICT", "Command cannot be claimed in its current state."));
    try {
      await ensureAgentDeploymentLifecycle(state, claimed, { status: "running", level: "info", marker: "Agent claimed deployment command", message: "Agent claimed deployment command; deployment is running." });
    } catch (error) {
      await compensateAgentLifecycleFailure(state, claimed);
      throw error;
    }
    return reply.send(claimed);
  });
  app.post(`${API_PREFIX}/agent/commands/:commandId/renew`, async (request, reply) => {
    if (!authenticateAgentRequest(request, reply, state.externalAgentIdentity)) return reply;
    const params = z.object({ commandId: commandIdSchema }).safeParse(request.params);
    const body = agentClaimBodySchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send(errorEnvelope(request, "VALIDATION_ERROR", "Invalid agent command request."));
    if (body.data.agentId !== state.externalAgentIdentity.agentId) return reply.code(403).send(errorEnvelope(request, "AGENT_IDENTITY_MISMATCH", "Agent identity mismatch."));
    const renewed = await state.deploymentCommandBus.renewLease(params.data.commandId, state.externalAgentIdentity.agentId);
    if (!renewed) {
      const existing = await assignedCommand(state, params.data.commandId, state.externalAgentIdentity.agentId);
      if (existing?.state === "claimed") await reconcileExpiredClaims(state, state.externalAgentIdentity.agentId);
      return reply.code(409).send(errorEnvelope(request, "COMMAND_LEASE_LOST", "Command lease could not be renewed."));
    }
    return reply.send(renewed);
  });
  app.post(`${API_PREFIX}/agent/commands/:commandId/complete`, async (request, reply) => {
    if (!authenticateAgentRequest(request, reply, state.externalAgentIdentity)) return reply;
    const params = z.object({ commandId: commandIdSchema }).safeParse(request.params);
    const body = agentCompleteBodySchema.safeParse(request.body ?? {});
    if (!params.success || !body.success) return reply.code(400).send(errorEnvelope(request, "VALIDATION_ERROR", "Invalid agent command request."));
    const existing = await assignedCommand(state, params.data.commandId, state.externalAgentIdentity.agentId);
    if (!existing) return reply.code(404).send(errorEnvelope(request, "NOT_FOUND", "Command not found."));
    if (existing.state === "completed") {
      await projectAuthoritativeTerminalCommand(state, existing);
      return reply.send(existing);
    }
    if (existing.state === "failed") {
      await projectAuthoritativeTerminalCommand(state, existing);
      return reply.code(409).send(terminalConflictResponse(request, existing, "completed"));
    }
    if (existing.state === "cancelled") {
      await projectAuthoritativeTerminalCommand(state, existing);
      return reply.code(409).send(terminalConflictResponse(request, existing, "completed"));
    }
    if (existing.state !== "claimed") return reply.code(409).send(errorEnvelope(request, "COMMAND_STATE_CONFLICT", "Command cannot be completed in its current state."));
    if (!existing.leaseExpiresAt || new Date(existing.leaseExpiresAt).getTime() <= state.now().getTime()) {
      const authoritative = await terminallyExpireAgentCommand(state, existing, "Agent command lease expired; completion was rejected.", "Agent command lease expired");
      if (authoritative?.state === "completed") return reply.send(authoritative);
      if (authoritative && authoritative.state !== "claimed") return reply.code(409).send(terminalConflictResponse(request, authoritative, "completed"));
      if (!authoritative) return reply.code(404).send(errorEnvelope(request, "NOT_FOUND", "Command not found."));
    }
    const completed = await state.deploymentCommandBus.complete(existing.id, body.data.output ? redactSecrets(body.data.output) : undefined);
    if (!completed) return reply.code(404).send(errorEnvelope(request, "NOT_FOUND", "Command not found."));
    await projectAuthoritativeTerminalCommand(state, completed);
    if (completed.state !== "completed") return reply.code(409).send(terminalConflictResponse(request, completed, "completed"));
    return reply.send(completed);
  });
  app.post(`${API_PREFIX}/agent/commands/:commandId/fail`, async (request, reply) => {
    if (!authenticateAgentRequest(request, reply, state.externalAgentIdentity)) return reply;
    const params = z.object({ commandId: commandIdSchema }).safeParse(request.params);
    const body = agentFailBodySchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send(errorEnvelope(request, "VALIDATION_ERROR", "Invalid agent command request."));
    const existing = await assignedCommand(state, params.data.commandId, state.externalAgentIdentity.agentId);
    if (!existing) return reply.code(404).send(errorEnvelope(request, "NOT_FOUND", "Command not found."));
    const safeReason = redactEnvFileForLog(body.data.reason).slice(0, 1024);
    if (existing.state === "failed") {
      await projectAuthoritativeTerminalCommand(state, existing, { marker: "Agent reported deployment failure", message: `Agent reported deployment failure: ${safeReason}` });
      return reply.send(existing);
    }
    if (existing.state === "completed") {
      await projectAuthoritativeTerminalCommand(state, existing);
      return reply.code(409).send(terminalConflictResponse(request, existing, "failed"));
    }
    if (existing.state === "cancelled") {
      await projectAuthoritativeTerminalCommand(state, existing);
      return reply.code(409).send(terminalConflictResponse(request, existing, "failed"));
    }
    if (existing.state !== "claimed") return reply.code(409).send(errorEnvelope(request, "COMMAND_STATE_CONFLICT", "Command cannot fail in its current state."));
    const failed = await state.deploymentCommandBus.fail(existing.id, safeReason);
    if (!failed) return reply.code(404).send(errorEnvelope(request, "NOT_FOUND", "Command not found."));
    if (failed.state === "claimed") {
      const authoritative = await state.deploymentCommandBus.findById(existing.id);
      if (!authoritative) return reply.code(404).send(errorEnvelope(request, "NOT_FOUND", "Command not found."));
      return reply.code(409).send(leaseConflictResponse(request, authoritative, "failed"));
    }
    await projectAuthoritativeTerminalCommand(state, failed, { marker: "Agent reported deployment failure", message: `Agent reported deployment failure: ${safeReason}` });
    if (failed.state !== "failed") return reply.code(409).send(terminalConflictResponse(request, failed, "failed"));
    return reply.send(failed);
  });
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
    const agent: Agent = { id: createRequestId(), name: body.name, endpoint: body.endpoint, status: "offline", lastHeartbeatAt: null, resourceSnapshot: null };
    await state.agents.save(agent);
    return ok(request, { agent, audit: auditMutation(request, "agent.register", "agent", agent.id) });
  });
  app.post(`${API_PREFIX}/agents/:agentId/heartbeat`, { preHandler: [requireAuth, requireMutationRole] }, async (request, reply) => {
    const params = z.object({ agentId: z.string().min(1) }).parse(request.params);
    const body = z.object({ observedAt: z.string().datetime({ offset: true }), resourceSnapshot: resourceSnapshotSchema }).parse(request.body);
    const receivedAt = state.now();
    if (!hasAcceptableAgentClockSkew(body.observedAt, receivedAt)) {
      return reply.code(400).send(errorEnvelope(request, "AGENT_CLOCK_SKEW", "Agent observedAt is outside the accepted clock-skew window."));
    }
    const agent = await state.agentStatus.recordHeartbeat({ agentId: params.agentId, observedAt: body.observedAt, resourceSnapshot: body.resourceSnapshot, ...request.correlationContext }, receivedAt);
    return ok(request, { agent, audit: auditMutation(request, "agent.heartbeat", "agent", agent.id) });
  });
  app.get(`${API_PREFIX}/agents`, { preHandler: requireAuth }, async (request) => {
    const agents = (await state.agents.list()).map((agent) => state.agentStatus.markStale(agent, state.now()));
    return ok(request, { agents });
  });
  app.get(`${API_PREFIX}/projects`, { preHandler: requireAuth }, async (request) => ok(request, { projects: await state.projects.list() }));
  app.post(`${API_PREFIX}/projects`, { preHandler: [requireAuth, requireMutationRole] }, async (request) => {
    const body = parseBody(projectCreateRequestSchema, request.body);
    const project: Project = {
      id: createRequestId(),
      name: body.name,
      repoUrl: body.repoUrl,
      defaultBranch: body.defaultBranch,
      buildCommand: body.buildCommand ?? null,
      runCommand: body.runCommand ?? null,
      port: body.port ?? null,
      description: body.description ?? null,
      imageTag: body.imageTag ?? null
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
      description: body.description !== undefined ? (body.description ?? null) : existing.description,
      imageTag: body.imageTag !== undefined ? (body.imageTag ?? null) : existing.imageTag
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
    const scope = body.scope ?? "project";
    const existingMetadata = await findEnvMetadata(state.envMetadata, params.projectId, body.key, scope);
    const existingSecretValue = existingMetadata
      ? null
      : await findEnvSecretValue(state.envSecretValues, params.projectId, body.key, scope);
    const now = new Date().toISOString();
    const record: EnvVariableMetadata = {
      id: existingMetadata?.id ?? `env_${createRequestId()}`,
      projectId: params.projectId,
      key: body.key,
      scope,
      valuePresent: existingMetadata?.valuePresent ?? Boolean(existingSecretValue),
      valueFingerprint: existingMetadata?.valueFingerprint ?? existingSecretValue?.valueFingerprint ?? null,
      required: body.required ?? false,
      description: body.description ?? null,
      updatedAt: now
    };
    const saved = await state.envMetadata.upsert(record);
    return ok(request, { envVariable: envVariableMetadataSchema.parse(saved), audit: auditMutation(request, "project.env.upsert", "project", params.projectId) });
  });
  app.delete(`${API_PREFIX}/projects/:projectId/env-variables`, { preHandler: [requireAuth, requireMutationRole] }, async (request, reply) => {
    const query = (request.query ?? {}) as Record<string, unknown>;
    const params = z.object({ projectId: z.string().min(1), key: z.string().min(1), scope: z.enum(["project", "deployment"]).default("project") }).parse({
      ...(request.params as Record<string, string>),
      key: typeof query.key === "string" ? query.key : undefined,
      scope: typeof query.scope === "string" ? query.scope : "project"
    });
    const removed = await state.envMetadata.remove(params.projectId, params.key, params.scope);
    if (removed) {
      await state.envSecretValues.remove(params.projectId, params.key, params.scope);
    }
    return removed
      ? ok(request, { removed: true, audit: auditMutation(request, "project.env.delete", "project", params.projectId) })
      : reply.code(404).send(errorEnvelope(request, "NOT_FOUND", "Env metadata not found."));
  });
  app.get(`${API_PREFIX}/projects/:projectId/env-values`, { preHandler: requireAuth }, async (request, reply) => {
    const params = z.object({ projectId: z.string().min(1) }).parse(request.params);
    const project = await state.projects.findById(params.projectId);
    if (!project) {
      return reply.code(404).send(errorEnvelope(request, "NOT_FOUND", "Project not found."));
    }
    const records = await state.envSecretValues.listByProject(params.projectId);
    return ok(request, { envValues: records.map((record) => envSecretValueSchema.parse(record)) });
  });
  app.post(`${API_PREFIX}/projects/:projectId/env-values`, { preHandler: [requireAuth, requireMutationRole] }, async (request, reply) => {
    const params = z.object({ projectId: z.string().min(1) }).parse(request.params);
    const body = parseBody(envSecretValueWriteRequestSchema, request.body);
    const project = await state.projects.findById(params.projectId);
    if (!project) {
      return reply.code(404).send(errorEnvelope(request, "NOT_FOUND", "Project not found."));
    }
    const scope = body.scope ?? "project";

    // Encrypt the raw value client-side of the database boundary. The encrypted
    // payload is the only thing that touches the repository: the raw plaintext
    // is intentionally never held past the encrypt() call and never appears in
    // audit metadata, logs, or response bodies.
    let encrypted: string;
    let fingerprint: string;
    try {
      encrypted = state.envSecretCipher.encrypt(body.value);
      fingerprint = state.envSecretCipher.fingerprint(body.value);
    } catch (error) {
      if (error instanceof EnvSecretKeyMissingError || error instanceof EnvSecretKeyInvalidError) {
        await appendAudit(adapters.audit, request, {
          actorUserId: request.auth?.user.id ?? null,
          action: "project.env-value.upsert.rejected",
          targetType: "env_value",
          targetId: `${params.projectId}:${scope}:${body.key}`,
          metadata: { reason: "secret-key-unavailable" }
        });
        return reply.code(503).send(errorEnvelope(request, "SECRET_KEY_UNAVAILABLE", "Env secret encryption is not configured. Set DEPLOYLITE_SECRET_KEY."));
      }
      throw error;
    }

    const saved = await state.envSecretValues.upsert({
      projectId: params.projectId,
      key: body.key,
      scope,
      encryptedValue: Buffer.from(encrypted, "base64"),
      valueFingerprint: fingerprint,
      keyVersion: ENCRYPTION_KEY_VERSION
    });

    // Reflect the new state on the metadata row so existing env-metadata
    // listings (which are still value-less) can answer "does this key have a
    // value yet?" without leaking the encrypted blob.
    const existingMetadata = await findEnvMetadata(state.envMetadata, params.projectId, body.key, scope);
    await state.envMetadata.upsert({
      id: existingMetadata?.id ?? `env_${createRequestId()}`,
      projectId: params.projectId,
      key: body.key,
      scope,
      valuePresent: true,
      valueFingerprint: fingerprint,
      required: existingMetadata?.required ?? false,
      description: existingMetadata?.description ?? null,
      updatedAt: saved.updatedAt
    });

    await appendAudit(adapters.audit, request, {
      actorUserId: request.auth?.user.id ?? null,
      action: "project.env-value.upsert",
      targetType: "env_value",
      targetId: saved.id,
      metadata: {
        projectId: params.projectId,
        key: body.key,
        scope,
        valueFingerprint: fingerprint,
        keyVersion: saved.keyVersion
      }
    });

    return ok(request, {
      envValue: envSecretValueSchema.parse(saved),
      audit: createAuditLogRecord({
        actorId: request.auth?.user.id ?? SCAFFOLD_ACTOR,
        action: "project.env-value.upsert",
        targetType: "env_value",
        targetId: saved.id,
        ...request.correlationContext
      })
    });
  });
  app.delete(`${API_PREFIX}/projects/:projectId/env-values`, { preHandler: [requireAuth, requireMutationRole] }, async (request, reply) => {
    const querySource = (request.query ?? {}) as Record<string, unknown>;
    const parsed = envSecretValueDeleteRequestSchema.safeParse({
      key: typeof querySource["key"] === "string" ? querySource["key"] : undefined,
      scope: typeof querySource["scope"] === "string" ? querySource["scope"] : "project"
    });
    if (!parsed.success) {
      return reply.code(400).send(errorEnvelope(request, "VALIDATION_ERROR", "Missing or invalid `key` (and optional `scope`) query parameter."));
    }
    const params = z.object({ projectId: z.string().min(1) }).parse(request.params);
    const project = await state.projects.findById(params.projectId);
    if (!project) {
      return reply.code(404).send(errorEnvelope(request, "NOT_FOUND", "Project not found."));
    }

    const removed = await state.envSecretValues.remove(params.projectId, parsed.data.key, parsed.data.scope);
    if (!removed) {
      return reply.code(404).send(errorEnvelope(request, "NOT_FOUND", "Env value not found."));
    }

    // Also clear the corresponding metadata row's value marker so the public
    // env-variables list does not keep reporting a now-stale fingerprint.
    const existingMetadata = await findEnvMetadata(state.envMetadata, params.projectId, parsed.data.key, parsed.data.scope);
    await state.envMetadata.upsert({
      id: existingMetadata?.id ?? `env_${createRequestId()}`,
      projectId: params.projectId,
      key: parsed.data.key,
      scope: parsed.data.scope,
      valuePresent: false,
      valueFingerprint: null,
      required: existingMetadata?.required ?? false,
      description: existingMetadata?.description ?? null,
      updatedAt: new Date().toISOString()
    });

    await appendAudit(adapters.audit, request, {
      actorUserId: request.auth?.user.id ?? null,
      action: "project.env-value.delete",
      targetType: "env_value",
      targetId: `${params.projectId}:${parsed.data.scope}:${parsed.data.key}`,
      metadata: { projectId: params.projectId, key: parsed.data.key, scope: parsed.data.scope }
    });

    return ok(request, {
      removed: true,
      audit: createAuditLogRecord({
        actorId: request.auth?.user.id ?? SCAFFOLD_ACTOR,
        action: "project.env-value.delete",
        targetType: "env_value",
        targetId: `${params.projectId}:${parsed.data.scope}:${parsed.data.key}`,
        ...request.correlationContext
      })
    });
  });
  app.post(`${API_PREFIX}/projects/:projectId/deployments`, { preHandler: [requireAuth, requireMutationRole] }, async (request, reply) => {
    const params = z.object({ projectId: z.string().min(1) }).parse(request.params);
    const project = await state.projects.findById(params.projectId);
    if (!project) {
      return reply.code(404).send(errorEnvelope(request, "NOT_FOUND", "Project not found."));
    }
    const body = parseBody(deployRequestSchema, request.body ?? {});
    if (body.agentId && state.externalAgentIdentity && body.agentId !== state.externalAgentIdentity.agentId) {
      return reply.code(409).send(errorEnvelope(request, "AGENT_IDENTITY_MISMATCH", "Requested agent is not bound to this control plane."));
    }
    const candidates = body.agentId ? [await state.agents.findById(body.agentId)] : await state.agents.list();
    const selected = candidates
      .filter((agent): agent is Agent => Boolean(agent))
      .map((agent) => state.agentStatus.markStale(agent, state.now()))
      .find((agent) => agent.status === "online" && (!state.externalAgentIdentity || agent.id === state.externalAgentIdentity.agentId));
    if (!selected) {
      return reply.code(409).send(errorEnvelope(request, "NO_AGENT_AVAILABLE", "No agent is online. Register an agent or bring one online before deploying."));
    }
    const agentId = selected.id;
    const commitSha = body.commitSha ?? "0000000";
    const deployment: Deployment = {
      id: createRequestId(),
      projectId: project.id,
      agentId,
      status: "queued",
      commitSha,
      startedAt: new Date().toISOString(),
      finishedAt: null
    };
    await state.deployments.save(deployment);
    // Publish a `start` command to the deployment command bus and
    // await the executor's synchronous part of the lifecycle. The
    // bus dispatches the command to the in-process executor (or, in
    // a later slice, to the real agent over the typed envelope).
    // The executor mirrors the legacy `DeployRunner` lifecycle so
    // the response and log surface stay byte-for-byte identical for
    // the slice-1 acceptance criteria. The `running` / `succeeded`
    // transitions arrive later through the existing SSE log stream
    // and `findById` polling.
    let dispatched: Awaited<ReturnType<DeploymentCommandBus["dispatch"]>>;
    try {
      const command = await state.deploymentCommandBus.submit({
        deploymentId: deployment.id,
        agentId: deployment.agentId,
        kind: "start",
        payload: { projectId: project.id, commitSha },
        requestedBy: request.auth?.user.id ?? null,
        requestId: request.correlationContext.requestId,
        correlationId: request.correlationContext.correlationId
      });
      // Production leaves the command pending for the authenticated external
      // agent. Local scaffold mode keeps the synchronous mock executor.
      dispatched = state.externalAgentIdentity ? command : await state.deploymentCommandBus.dispatch(command);
      if (!dispatched) {
        throw new Error("Deployment command was not dispatched");
      }
    } catch (error) {
      const failed: Deployment = { ...deployment, status: "failed", finishedAt: new Date().toISOString() };
      await state.deployments.save(failed);
      await state.deployments.appendAllocatedLog({
        id: createRequestId(),
        deploymentId: deployment.id,
        level: "error",
        message: "Deployment command submission or dispatch failed.",
        timestamp: new Date().toISOString(),
        redactionApplied: true,
        requestId: request.correlationContext.requestId,
        correlationId: request.correlationContext.correlationId
      });
      throw error;
    }
    const refreshed = dispatched ? await state.deployments.findById(deployment.id) : null;
    const observed = refreshed ?? deployment;
    const envVariables = await state.envMetadata.listByProject(project.id);
    return ok(request, {
      deployment: observed,
      envVariables: envVariables.map((record) => envVariableMetadataSchema.parse(record)),
      audit: auditMutation(request, "deployment.trigger", "deployment", deployment.id)
    });
  });
  app.get(`${API_PREFIX}/deployments/:deploymentId`, { preHandler: requireAuth }, async (request, reply) => {
    const params = z.object({ deploymentId: z.string().min(1) }).parse(request.params);
    const scoped = await resolveDeploymentScope(state, params.deploymentId);
    return scoped ? ok(request, { deployment: scoped.deployment }) : reply.code(404).send(errorEnvelope(request, "NOT_FOUND", "Deployment not found."));
  });
  app.get(`${API_PREFIX}/deployments`, { preHandler: requireAuth }, async (request) => ok(request, { deployments: await state.deployments.list() }));
  // Audit history list — operator/admin only. The response shape strips
  // per-row metadata so the API can never echo secret keys, fingerprints, or
  // other sensitive detail by accident (Task 4.6: safe metadata only).
  app.get(`${API_PREFIX}/audit-events`, { preHandler: [requireAuth, requireAuditReadRole] }, async (request, reply) => {
    const raw = (request.query ?? {}) as Record<string, unknown>;
    const parsed = z
      .object({
        actor: z.string().min(1).max(128).optional(),
        action: z.string().min(1).max(128).optional(),
        projectId: z.string().min(1).max(128).optional(),
        limit: z.coerce.number().int().min(1).max(MAX_AUDIT_LIST_LIMIT).optional(),
        offset: z.coerce.number().int().min(0).max(MAX_AUDIT_LIST_OFFSET).optional()
      })
      .safeParse({
        actor: typeof raw["actor"] === "string" && raw["actor"].length > 0 ? raw["actor"] : undefined,
        action: typeof raw["action"] === "string" && raw["action"].length > 0 ? raw["action"] : undefined,
        projectId: typeof raw["projectId"] === "string" && raw["projectId"].length > 0 ? raw["projectId"] : undefined,
        limit: typeof raw["limit"] === "string" && raw["limit"].length > 0 ? raw["limit"] : undefined,
        offset: typeof raw["offset"] === "string" && raw["offset"].length > 0 ? raw["offset"] : undefined
      });
    if (!parsed.success) {
      await appendAudit(adapters.audit, request, {
        actorUserId: request.auth?.user.id ?? null,
        action: "audit.list.rejected",
        targetType: "audit_events",
        targetId: "list",
        metadata: { reason: "invalid-query" }
      });
      return reply.code(400).send(errorEnvelope(request, "VALIDATION_ERROR", "Invalid audit-events query parameters."));
    }
    const page = await adapters.audit.list({
      actorUserId: parsed.data.actor,
      action: parsed.data.action,
      projectId: parsed.data.projectId,
      limit: parsed.data.limit,
      offset: parsed.data.offset
    });
    return ok(request, page);
  });
  app.get(`${API_PREFIX}/deployments/:deploymentId/logs`, { preHandler: requireAuth }, async (request, reply) => {
    const params = z.object({ deploymentId: z.string().min(1) }).parse(request.params);
    const scoped = await resolveDeploymentScope(state, params.deploymentId);
    if (!scoped) return reply.code(404).send(errorEnvelope(request, "NOT_FOUND", "Deployment not found."));
    return ok(request, { events: await state.deployments.listLogs(scoped.deployment.id) });
  });
  app.get(`${API_PREFIX}/deployments/:deploymentId/logs/stream`, { preHandler: requireAuth }, async (request, reply) => {
    const params = z.object({ deploymentId: z.string().min(1) }).parse(request.params);
    const scoped = await resolveDeploymentScope(state, params.deploymentId);
    if (!scoped) return reply.code(404).send(errorEnvelope(request, "NOT_FOUND", "Deployment not found."));
    let cursor = sseResumeCursor(request);
    let emitting = false;
    let closed = false;
    const raw = reply.raw;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      request.raw.off("close", cleanup);
      raw.off("close", cleanup);
    };
    const write = (event: string, data: Record<string, unknown>, id?: number) => {
      if (!closed) raw.write(`${id === undefined ? "" : `id: ${id}\n`}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const emit = async () => {
      if (closed || emitting) return;
      emitting = true;
      try {
        const current = await state.deployments.findById(scoped.deployment.id);
        const persistedLogs = await state.deployments.listLogs(scoped.deployment.id);
        if (cursor >= 0 && (persistedLogs.length === 0 || cursor < persistedLogs[0]!.sequence || cursor > persistedLogs.at(-1)!.sequence)) {
          cursor = -1;
        }
        const logs = persistedLogs.filter((log) => log.sequence > cursor).slice(0, SSE_LOG_PAGE_LIMIT);
        const hasMoreLogs = logs.length === SSE_LOG_PAGE_LIMIT;
        for (const log of logs) {
          cursor = log.sequence;
          write("deployment.log", { ...log, stream: request.correlationContext }, log.sequence);
        }
        raw.write(": keepalive\n\n");
        const terminal = !current || ["succeeded", "failed", "canceled"].includes(current.status);
        if (!terminal || !hasMoreLogs) write("deployment.status", { status: current?.status ?? "unavailable" });
        if (terminal && !hasMoreLogs) {
          write("deployment.terminal", { status: current?.status ?? "unavailable" });
          cleanup();
          raw.end();
        }
      } finally {
        emitting = false;
      }
    };
    reply.hijack();
    raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no"
    });
    const timer = setInterval(() => void emit(), SSE_POLL_INTERVAL_MS);
    request.raw.once("close", cleanup);
    raw.once("close", cleanup);
    await emit();
  });
  app.post(`${API_PREFIX}/deployments/:deploymentId/cancel`, { preHandler: [requireAuth, requireMutationRole] }, async (request, reply) => {
    const params = z.object({ deploymentId: z.string().min(1) }).parse(request.params);
    const scoped = await resolveDeploymentScope(state, params.deploymentId);
    if (!scoped) return reply.code(404).send(errorEnvelope(request, "NOT_FOUND", "Deployment not found."));

    const active = await state.deploymentCommandBus.findActiveForDeployment(scoped.deployment.id);
    const command = active
      ? await state.deploymentCommandBus.cancel(active.id, request.auth?.user.id ?? null)
      : (await state.deploymentCommandBus.list())
          .filter((item) => item.deploymentId === scoped.deployment.id)
          .sort((left, right) => right.issuedAt.localeCompare(left.issuedAt))[0] ?? null;
    if (!command) {
      await appendAudit(adapters.audit, request, {
        actorUserId: request.auth?.user.id ?? null,
        action: "deployment.cancel.rejected",
        targetType: "deployment",
        targetId: scoped.deployment.id,
        metadata: { projectId: scoped.project.id, agentId: scoped.agent.id, reason: "missing-command" }
      });
      return reply.code(409).send(errorEnvelope(request, "COMMAND_UNAVAILABLE", "This deployment has no command that can be cancelled."));
    }
    if (command.state === "cancelled") {
      await reconcileCancelledDeployment(state, command, request);
    }
    await appendAudit(adapters.audit, request, {
      actorUserId: request.auth?.user.id ?? null,
      action: "deployment.cancel",
      targetType: "deployment",
      targetId: scoped.deployment.id,
      metadata: { projectId: scoped.project.id, agentId: scoped.agent.id, commandId: command.id, outcome: command.state }
    });
    return ok(request, { deployment: (await state.deployments.findById(scoped.deployment.id)) ?? scoped.deployment, command, idempotent: !active });
  });
  for (const action of ["restart", "rollback"] as const) {
    app.post(`${API_PREFIX}/deployments/:deploymentId/${action}`, { preHandler: [requireAuth, requireMutationRole] }, async (request, reply) => {
      const params = z.object({ deploymentId: z.string().min(1) }).parse(request.params);
      const scoped = await resolveDeploymentScope(state, params.deploymentId);
      if (!scoped) return reply.code(404).send(errorEnvelope(request, "NOT_FOUND", "Deployment not found."));
      // The current external agent only materializes and executes `start`.
      // Do not turn a UI request into an invented Docker mutation: restart and
      // rollback remain safely unavailable until the agent advertises support.
      const code = action === "rollback" ? "ROLLBACK_UNAVAILABLE" : "EXECUTOR_CAPABILITY_UNAVAILABLE";
      const message = action === "rollback"
        ? "Rollback is unavailable because no verified prior deployment image is recorded."
        : "Restart is unavailable because the assigned agent does not advertise restart support.";
      await appendAudit(adapters.audit, request, {
        actorUserId: request.auth?.user.id ?? null,
        action: `deployment.${action}.rejected`,
        targetType: "deployment",
        targetId: scoped.deployment.id,
        metadata: { projectId: scoped.project.id, agentId: scoped.agent.id, reason: code }
      });
      await appendDeploymentControlLog(state, scoped.deployment.id, "warn", `Authorized ${action} request was rejected safely: ${code}.`, request);
      return reply.code(409).send(errorEnvelope(request, code, message));
    });
  }
  app.post(`${API_PREFIX}/deployments`, { preHandler: [requireAuth, requireMutationRole] }, async (request) => {
    const body = parseBody(deploymentSchema.omit({ id: true, startedAt: true, finishedAt: true }), request.body);
    const deployment: Deployment = { id: createRequestId(), startedAt: new Date().toISOString(), finishedAt: null, ...body };
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
  if (repositories.state.externalAgentIdentity) {
    const agentId = repositories.state.externalAgentIdentity.agentId;
    await reconcileExpiredClaims(repositories.state, agentId);
    const reconciliationTimer = setInterval(() => {
      void reconcileExpiredClaims(repositories.state, agentId).catch(() => {
        if (typeof console !== "undefined") console.error("[deployment-command-reconciliation] reconciliation failed");
      });
    }, Math.max(100, options.commandReconciliationIntervalMs ?? 5_000));
    reconciliationTimer.unref();
    app.addHook("onClose", () => clearInterval(reconciliationTimer));
  }
  app.addHook("onClose", () => {
    repositories.state.cancelDeploymentExecutorTimers();
  });
  return app;
}

export { API_PREFIX, AUTH_HEADER, InMemoryAuditRepository, InMemoryAuthUserRepository, InMemorySessionRepository, createRuntimeRepositories, type ApiRepositories, type BuildApiAppOptions };

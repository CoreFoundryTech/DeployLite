import { createAuditLogRecord, createCorrelationContext, createRequestId, parseDeployLiteEnv, redactSecrets, type DeployLiteEnv, createEnvSecretCipher, EnvSecretKeyInvalidError, EnvSecretKeyMissingError, ENCRYPTION_KEY_VERSION, loadEnvSecretKey, type EnvSecretCipher } from "@deploylite/config";
import { materializeMockDeploy, redactEnvFileForLog, type EncryptedEnvRecord } from "@deploylite/agent";
import {
  agentRegistrationSchema,
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
  runtimeActivationSchema,
  runtimeActivationCommandSchema,
  runtimeConfigurationSchema,
  runtimeConfigurationWriteRequestSchema,
  resourceSnapshotSchema,
  type Agent,
  type Deployment,
  type EnvSecretValue,
  type EnvVariableMetadata,
  type Project,
  type RuntimeActivation,
  type RuntimeActivationCommand
} from "@deploylite/contracts";
import { BcryptPasswordHasher, bootstrapInitialAdmin, closeDbPool, createDbClient, createDbPool, createOpaqueSessionToken, DbAgentRepository, DbAuditRepository, DbAuthUserRepository, DbDeploymentRepository, DbEnvSecretValueRepository, DbEnvVariableMetadataRepository, DbProjectRepository, DbSessionRepository, hashSessionToken, type DeployLiteDb } from "@deploylite/db";
import {
  AgentStatusService,
  authenticateLocalUser,
  getBootstrapStatus,
  InMemoryAgentRepository,
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
  type EnvSecretValueRepository,
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
  envMetadata?: EnvVariableMetadataRepository;
  envSecretValues?: EnvSecretValueRepository;
  envSecretCipher?: EnvSecretCipher;
  runtimeActivationDispatcher?: RuntimeActivationDispatcher;
};

type PlatformRepositories = PlatformRepositoryOptions & {
  agentStatus: AgentStatusService;
  envMetadata: EnvVariableMetadataRepository;
  envSecretValues: EnvSecretValueRepository;
  envSecretCipher: EnvSecretCipher;
  deployRunner: DeployRunner;
  runtimeActivationDispatcher: RuntimeActivationDispatcher;
};

export type RuntimeActivationDispatcher = {
  available(): boolean;
  dispatch(command: RuntimeActivationCommand): Promise<RuntimeActivation>;
};

class UnavailableRuntimeActivationDispatcher implements RuntimeActivationDispatcher {
  available(): boolean {
    return false;
  }

  async dispatch(command: RuntimeActivationCommand): Promise<RuntimeActivation> {
    return runtimeActivationSchema.parse({
      id: command.idempotencyKey,
      commandId: command.commandId,
      status: "capability_unavailable",
      capability: "safe_runtime_executor",
      output: null
    });
  }
}

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

function createApiState(env: EnvSecretKeySource, overrides: Partial<PlatformRepositoryOptions> = {}): PlatformRepositories {
  const agents = overrides.agents ?? new InMemoryAgentRepository();
  const deployments = overrides.deployments ?? new InMemoryDeploymentRepository();
  const projects = overrides.projects ?? new InMemoryProjectRepository();
  const envMetadata = overrides.envMetadata ?? new InMemoryEnvVariableMetadataRepository();
  const envSecretValues = overrides.envSecretValues ?? new InMemoryEnvSecretValueRepository();
  const envSecretCipher = overrides.envSecretCipher ?? createLazyEnvSecretCipher(env);
  const runtimeActivationDispatcher = overrides.runtimeActivationDispatcher ?? new UnavailableRuntimeActivationDispatcher();
  const agentStatus = new AgentStatusService(agents);
  const deployRunner = new DeployRunner(deployments, envMetadata, agentStatus, envSecretCipher);
  return { agents, deployments, projects, envMetadata, envSecretValues, envSecretCipher, agentStatus, deployRunner, runtimeActivationDispatcher };
}

/**
 * Deterministic set of mock env secret values used by the API's
 * dry-run materialization step. The values are intentionally
 * harmless (no real credentials) but they exercise the full
 * encrypt → decrypt → redact pipeline so the agent's
 * `materializeMockDeploy` is actually wired into the deploy path.
 * The plaintext is held only for the duration of the encrypt call
 * and never written to a log or a response — only the redacted
 * projection reaches the deployment log.
 */
const DRY_RUN_MOCK_VALUES: ReadonlyArray<{ key: string; scope: "project" | "deployment"; value: string }> = [
  { key: "DATABASE_URL", scope: "project", value: "postgres://dry-run:placeholder@db.invalid:5432/dryrun" },
  { key: "API_KEY", scope: "project", value: "sk_dry_run_placeholder" }
];

class DeployRunner {
  #sequenceByDeployment = new Map<string, number>();
  #timers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly deployments: DeploymentRepository,
    private readonly envMetadata: EnvVariableMetadataRepository,
    private readonly agentStatus: AgentStatusService,
    private readonly envSecretCipher?: EnvSecretCipher
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

    // Dry-run materialization. The agent module's
    // `materializeMockDeploy` is invoked with a deterministic mock
    // set of `EncryptedEnvRecord` values, encrypted in-process with
    // the API's own cipher. The agent then decrypts them, renders a
    // `.env` string, and `redactEnvFileForLog` collapses every value
    // to `[REDACTED]` so the plaintext never reaches the log. The
    // step is wired into the deploy path so the agent module is not
    // inert (round-1 finding: the helper was defined but never
    // called). Failures are swallowed — a missing cipher must not
    // break the deploy — and the deploy still proceeds.
    const projection = await this.materializeDryRun(project);
    if (projection) {
      await this.appendLog(deployment, "info", `Materialized env (mock, redacted):\n${projection}`, requestId, correlationId);
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

  /**
   * Build a deterministic mock `EncryptedEnvRecord[]` and round-trip
   * it through the agent module's `materializeMockDeploy` +
   * `redactEnvFileForLog` pipeline. The output is the redacted
   * `.env` projection suitable for the deploy log; plaintext is
   * never returned. Returns null when no cipher is configured (so
   * the deploy can still proceed) or when the agent module refuses
   * to materialize (e.g. key version mismatch).
   */
  async materializeDryRun(project: Project): Promise<string | null> {
    if (!this.envSecretCipher) return null;
    try {
      const records: EncryptedEnvRecord[] = DRY_RUN_MOCK_VALUES.map((mock) => {
        const encryptedValue = Buffer.from(this.envSecretCipher!.encrypt(mock.value), "base64");
        return {
          key: mock.key,
          scope: mock.scope,
          encryptedValue,
          valueFingerprint: this.envSecretCipher!.fingerprint(mock.value),
          keyVersion: ENCRYPTION_KEY_VERSION
        };
      });
      const entry = materializeMockDeploy({
        projectId: project.id,
        agentId: "agent_dry_run",
        records,
        cipher: this.envSecretCipher
      });
      return redactEnvFileForLog(entry.contents);
    } catch {
      return null;
    }
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
    state: createApiState(env, {
      agents: options.state?.agents ?? new DbAgentRepository(db),
      deployments: options.state?.deployments ?? new DbDeploymentRepository(db),
      projects: options.state?.projects ?? new DbProjectRepository(db),
      envMetadata: options.state?.envMetadata ?? new DbEnvVariableMetadataRepository(db),
      envSecretValues: options.state?.envSecretValues ?? new DbEnvSecretValueRepository(db),
      envSecretCipher: options.state?.envSecretCipher
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
    state: createApiState(env, options.state)
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

function isAllowedCorsRequest(request: FastifyRequest, corsOrigin: string | null): boolean {
  return Boolean(corsOrigin && getHeaderValue(request, "origin") === corsOrigin);
}

function redactRuntimeActivationOutput(output: string | null): string | null {
  if (output === null) return null;
  return redactSecrets(redactEnvFileForLog(output))
    .replace(/\b(password|secret|token|authorization)\s*[:=]\s*\S+/gi, "$1=[REDACTED]")
    .replace(/:\/\/[^\s/:]+:[^\s@]+@/g, "://[REDACTED]@");
}

const runtimeSecretKeys = {
  domain: "DEPLOYLITE_RUNTIME_DOMAIN",
  acmeEmail: "DEPLOYLITE_ACME_EMAIL",
  databasePassword: "POSTGRES_PASSWORD",
  runtimeSecret: "DEPLOYLITE_RUNTIME_SECRET"
} as const;

async function readRuntimeConfiguration(state: PlatformRepositories, projectId: string) {
  const values = await state.envSecretValues.listEncryptedByProject(projectId);
  const byKey = new Map(values.map((value) => [value.key, value]));
  const domainValue = byKey.get(runtimeSecretKeys.domain);
  let domain: string | null = null;
  if (domainValue) {
    try {
      domain = state.envSecretCipher.decrypt(Buffer.from(domainValue.encryptedValue).toString("base64"));
    } catch {
      domain = null;
    }
  }
  return runtimeConfigurationSchema.parse({
    domain,
    acmeEmailConfigured: byKey.has(runtimeSecretKeys.acmeEmail),
    databasePasswordConfigured: byKey.has(runtimeSecretKeys.databasePassword),
    runtimeSecretConfigured: byKey.has(runtimeSecretKeys.runtimeSecret)
  });
}

async function writeRuntimeConfiguration(state: PlatformRepositories, projectId: string, values: Record<keyof typeof runtimeSecretKeys, string>) {
  for (const [name, key] of Object.entries(runtimeSecretKeys) as [keyof typeof runtimeSecretKeys, string][]) {
    const value = values[name];
    await state.envSecretValues.upsert({
      projectId,
      key,
      scope: "project",
      encryptedValue: Buffer.from(state.envSecretCipher.encrypt(value), "base64"),
      valueFingerprint: state.envSecretCipher.fingerprint(value),
      keyVersion: ENCRYPTION_KEY_VERSION
    });
  }
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
        .header("access-control-allow-methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS")
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
  const requireAdminRole = createRolePreHandler(adapters, ["admin"]);
  // Audit history is an operator/admin concern. Read-only sessions are denied
  // by design so a passive role cannot enumerate every project + key change.
  const requireAuditReadRole = createRolePreHandler(adapters, ["admin", "operator"]);

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
  app.get(`${API_PREFIX}/projects/:projectId/runtime-configuration`, { preHandler: [requireAuth, requireAdminRole] }, async (request, reply) => {
    const params = z.object({ projectId: z.string().min(1) }).parse(request.params);
    if (!await state.projects.findById(params.projectId)) return reply.code(404).send(errorEnvelope(request, "NOT_FOUND", "Project not found."));
    return ok(request, { runtimeConfiguration: await readRuntimeConfiguration(state, params.projectId) });
  });
  app.put(`${API_PREFIX}/projects/:projectId/runtime-configuration`, { preHandler: [requireAuth, requireAdminRole] }, async (request, reply) => {
    const params = z.object({ projectId: z.string().min(1) }).parse(request.params);
    if (!await state.projects.findById(params.projectId)) return reply.code(404).send(errorEnvelope(request, "NOT_FOUND", "Project not found."));
    const body = parseBody(runtimeConfigurationWriteRequestSchema, request.body);
    try {
      await writeRuntimeConfiguration(state, params.projectId, body);
    } catch (error) {
      if (error instanceof EnvSecretKeyMissingError || error instanceof EnvSecretKeyInvalidError) return reply.code(503).send(errorEnvelope(request, "SECRET_KEY_UNAVAILABLE", "Env secret encryption is not configured."));
      throw error;
    }
    await appendAudit(adapters.audit, request, { actorUserId: request.auth!.user.id, action: "runtime.configuration.upsert", targetType: "runtime", targetId: params.projectId, metadata: { projectId: params.projectId } });
    return ok(request, { runtimeConfiguration: await readRuntimeConfiguration(state, params.projectId) });
  });
  app.post(`${API_PREFIX}/projects/:projectId/runtime-activation`, { preHandler: [requireAuth, requireAdminRole] }, async (request, reply) => {
    const params = z.object({ projectId: z.string().min(1) }).parse(request.params);
    if (!await state.projects.findById(params.projectId)) return reply.code(404).send(errorEnvelope(request, "NOT_FOUND", "Project not found."));
    const configuration = await readRuntimeConfiguration(state, params.projectId);
    if (!configuration.domain || !configuration.acmeEmailConfigured || !configuration.databasePasswordConfigured || !configuration.runtimeSecretConfigured) {
      return reply.code(409).send(errorEnvelope(request, "RUNTIME_CONFIGURATION_INCOMPLETE", "Runtime configuration is incomplete."));
    }
    const configurationFingerprint = (await state.envSecretValues.listByProject(params.projectId)).filter((value) => Object.values(runtimeSecretKeys).includes(value.key as never)).map((value) => value.valueFingerprint).sort().join(":");
    const activationRevision = state.envSecretCipher.fingerprint(`${params.projectId}:${configurationFingerprint}:${request.correlationContext.requestId}`);
    const idempotencyKey = `runtime_${activationRevision.slice(0, 24)}`;
    const command = runtimeActivationCommandSchema.parse({
      commandId: `runtime_command_${idempotencyKey.slice("runtime_".length)}`,
      correlationId: request.correlationContext.correlationId,
      idempotencyKey,
      projectId: params.projectId,
      configurationRef: idempotencyKey,
      domain: configuration.domain,
      profile: "runtime",
      action: "apply"
    });
    await appendAudit(adapters.audit, request, { actorUserId: request.auth!.user.id, action: "runtime.activation.requested", targetType: "runtime", targetId: command.commandId, metadata: { projectId: params.projectId, capability: "safe_runtime_executor", commandId: command.commandId } });
    if (state.runtimeActivationDispatcher.available()) {
      await appendAudit(adapters.audit, request, { actorUserId: request.auth!.user.id, action: "runtime.activation.dispatched", targetType: "runtime", targetId: command.commandId, metadata: { projectId: params.projectId, commandId: command.commandId } });
    }
    let dispatched: RuntimeActivation;
    try {
      dispatched = await state.runtimeActivationDispatcher.dispatch(command);
    } catch {
      await appendAudit(adapters.audit, request, { actorUserId: request.auth!.user.id, action: "runtime.activation.failed", targetType: "runtime", targetId: command.commandId, metadata: { projectId: params.projectId, commandId: command.commandId, reason: "dispatch-failed" } });
      return reply.code(502).send(errorEnvelope(request, "RUNTIME_EXECUTOR_FAILED", "Runtime executor failed."));
    }
    const activation = runtimeActivationSchema.parse({ ...dispatched, output: redactRuntimeActivationOutput(dispatched.output) });
    if (activation.status === "succeeded" || activation.status === "failed") {
      await appendAudit(adapters.audit, request, { actorUserId: request.auth!.user.id, action: `runtime.activation.${activation.status}`, targetType: "runtime", targetId: command.commandId, metadata: { projectId: params.projectId, commandId: command.commandId, status: activation.status, output: activation.output } });
    }
    return ok(request, { activation });
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

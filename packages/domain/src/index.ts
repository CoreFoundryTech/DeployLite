import type { Agent, AgentHeartbeat, Deployment, DeploymentCommand, DeploymentCommandKind, DeploymentCommandState, EnvSecretValue, EnvVariableMetadata, LogEvent, Project, ScaffoldUser } from "@deploylite/contracts";
import {
  createEnvSecretCipher,
  EnvSecretCipherError,
  EnvSecretKeyMissingError,
  loadEnvSecretKey,
  redactLogMessage,
  redactSecrets,
  type EnvSecretCipher
} from "@deploylite/config";

export const canonicalRoleNames = ["admin", "operator", "read-only", "auditor"] as const;
export type CanonicalRoleName = (typeof canonicalRoleNames)[number];
export type AuthUserStatus = "active" | "disabled";

export type AuthUser = {
  id: string;
  email: string;
  emailNormalized: string;
  passwordHash: string;
  role: CanonicalRoleName;
  status: AuthUserStatus;
  createdAt: Date;
  updatedAt: Date;
};

export type SafeAuthUser = Omit<AuthUser, "passwordHash">;

export type AuthRole = {
  id: string;
  name: CanonicalRoleName;
  description: string;
  createdAt: Date;
};

export type AuthSession = {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: Date;
  revokedAt: Date | null;
  ipHash: string | null;
  userAgent: string | null;
  createdAt: Date;
  lastSeenAt: Date | null;
};

export type CreateInitialAdminInput = {
  email: string;
  passwordHash: string;
};

export type CreateSessionInput = {
  userId: string;
  tokenHash: string;
  expiresAt: Date;
  ipHash?: string | null;
  userAgent?: string | null;
};

export type AuditEventInput = {
  actorUserId?: string | null;
  action: string;
  targetType: string;
  targetId: string;
  requestId: string;
  correlationId: string;
  metadata?: Record<string, unknown>;
};

export type AuditEvent = {
  id: string;
  actorId: string;
  action: string;
  targetType: string;
  targetId: string;
  requestId: string;
  correlationId: string;
  timestamp: string;
};

/**
 * Public, metadata-free list shape for the audit events API. The list surface
 * intentionally omits the per-row `metadata` object so the GET response can
 * never echo secret keys, fingerprints, or any other sensitive detail by
 * accident. The metadata is still persisted on each event for the in-memory
 * `inputs` mirror and DB row, but the API only returns it to the caller if a
 * future, narrower endpoint opts in.
 */
export type AuditEventListItem = Pick<AuditEvent, "id" | "actorId" | "action" | "targetType" | "targetId" | "requestId" | "correlationId" | "timestamp">;

export type AuditEventListFilter = {
  actorUserId?: string;
  action?: string;
  projectId?: string;
  limit?: number;
  offset?: number;
};

export type AuditEventListPage = {
  events: AuditEventListItem[];
  total: number;
  limit: number;
  offset: number;
};

export type AgentRepository = {
  save(agent: Agent): Promise<Agent>;
  findById(id: string): Promise<Agent | null>;
  list(): Promise<Agent[]>;
};

// Re-exported for the executor port: the deployment executor
// operates on a `Deployment` and resolves a `Project` from the
// command payload. Both types live in `@deploylite/contracts` so
// the API and the (future) agent share one source of truth.
export type { Deployment, Project } from "@deploylite/contracts";

export type DeploymentRepository = {
  save(deployment: Deployment): Promise<Deployment>;
  findById(id: string): Promise<Deployment | null>;
  list(): Promise<Deployment[]>;
  appendLog(event: LogEvent): Promise<LogEvent>;
  appendAllocatedLog(event: Omit<LogEvent, "sequence">): Promise<LogEvent>;
  listLogs(deploymentId: string, afterSequence?: number): Promise<LogEvent[]>;
};

// =====================================================================
// Deployment command bus port.
//
// Slice 1 introduces the typed control-plane surface that will eventually
// carry cancel / restart / rollback commands from the API to the (real)
// deployment agent. The port is intentionally socket-free: the only
// side effects are the `DeploymentCommandRepository` write path and the
// in-process event listener registry. The agent is the consumer (the
// `DeploymentExecutor` in `apps/api/src/commands` for now; the real
// agent in a later slice) and the only component that owns the privileged
// execution path.
// =====================================================================

export type DeploymentCommandRecord = DeploymentCommand;

/**
 * A single, fenced lifecycle projection. Implementations must update the
 * command fence (when applicable), deployment, allocated log, and audit event
 * atomically; callers must never compose these writes themselves.
 */
export type DeploymentLifecycleProjection = {
  deployment: Deployment;
  log: Omit<LogEvent, "sequence">;
  audit: AuditEventInput;
};

export type DeploymentCommandEventType =
  | "deployment.command.submitted"
  | "deployment.command.claimed"
  | "deployment.command.executing"
  | "deployment.command.completed"
  | "deployment.command.failed"
  | "deployment.command.cancelled";

export type DeploymentCommandEvent = {
  type: DeploymentCommandEventType;
  command: DeploymentCommandRecord;
  occurredAt: string;
};

export type DeploymentCommandEventListener = (event: DeploymentCommandEvent) => void | Promise<void>;

export type DeploymentCommandBusSubmitInput = {
  deploymentId: string;
  agentId: string;
  kind: DeploymentCommandKind;
  payload?: Record<string, unknown>;
  requestedBy: string | null;
  requestId: string;
  correlationId: string;
};

export type DeploymentCommandBus = {
  submit(input: DeploymentCommandBusSubmitInput): Promise<DeploymentCommandRecord>;
  claim(commandId: string, agentId: string): Promise<DeploymentCommandRecord | null>;
  reserveExecution(commandId: string, agentId: string): Promise<DeploymentCommandRecord | null>;
  renewLease(commandId: string, agentId: string): Promise<DeploymentCommandRecord | null>;
  complete(commandId: string, output?: Record<string, unknown>): Promise<DeploymentCommandRecord | null>;
  fail(commandId: string, reason: string): Promise<DeploymentCommandRecord | null>;
  failSystem(commandId: string, reason: string): Promise<DeploymentCommandRecord | null>;
  failExpiredClaim(commandId: string, reason: string): Promise<DeploymentCommandRecord | null>;
  cancel(commandId: string, requestedBy: string | null): Promise<DeploymentCommandRecord | null>;
  list(): Promise<DeploymentCommandRecord[]>;
  findById(commandId: string): Promise<DeploymentCommandRecord | null>;
  findActiveForDeployment(deploymentId: string): Promise<DeploymentCommandRecord | null>;
  dispatch(command: DeploymentCommandRecord): Promise<DeploymentCommandRecord | null>;
  onEvent(listener: DeploymentCommandEventListener): () => void;
};

export type DeploymentExecutor = {
  /**
   * Drive the side effects for a freshly-claimed deployment command.
   * The executor is the ONLY component allowed to mutate the
   * deployment status, append deployment logs, or touch the host. The
   * bus dispatches `execute` after a successful `claim`; the executor
   * is responsible for calling `complete` / `fail` on the bus when it
   * finishes.
   */
  execute(command: DeploymentCommandRecord): Promise<void>;
  cancelTimers(): void;
};

export type DeploymentCommandRepository = {
  save(command: DeploymentCommandRecord): Promise<DeploymentCommandRecord>;
  claim(commandId: string, agentId: string, claimedAt: string, leaseExpiresAt: string): Promise<DeploymentCommandRecord | null>;
  reserveExecution(commandId: string, agentId: string, now: string): Promise<DeploymentCommandRecord | null>;
  renewLease(commandId: string, agentId: string, now: string, leaseExpiresAt: string): Promise<DeploymentCommandRecord | null>;
  transitionTerminal(
    commandId: string,
    agentId: string,
    expectedState: "pending" | "claimed" | "executing",
    next: Pick<DeploymentCommandRecord, "state" | "completedAt" | "leaseExpiresAt" | "failureReason" | "payload">,
    condition?: { leaseExpiresAtNotAfterNow: () => string } | { leaseExpiresAtAfterNow: () => string }
  ): Promise<{ command: DeploymentCommandRecord; applied: boolean } | null>;
  findById(id: string): Promise<DeploymentCommandRecord | null>;
  findActiveForDeployment(deploymentId: string): Promise<DeploymentCommandRecord | null>;
  list(): Promise<DeploymentCommandRecord[]>;
};

/**
 * Opt-in persistence capability for lifecycle projection. Keeping this separate
 * from the command state-machine repository lets existing command-only adapters
 * remain valid until the executor integration adopts the projection boundary.
 */
export type DeploymentCommandProjectionRepository = {
  projectRunning(commandId: string, agentId: string, projection: DeploymentLifecycleProjection): Promise<{ command: DeploymentCommandRecord; applied: boolean } | null>;
};

/** Projects an authoritative terminal command with its deployment, log, and audit effects. */
export type DeploymentCommandTerminalProjectionRepository = {
  transitionTerminalAndProject(
    commandId: string,
    agentId: string,
    expectedState: "pending" | "claimed" | "executing",
    next: Pick<DeploymentCommandRecord, "state" | "completedAt" | "leaseExpiresAt" | "failureReason" | "payload">,
    projection: DeploymentLifecycleProjection,
    condition?: { leaseExpiresAtNotAfterNow: () => string } | { leaseExpiresAtAfterNow: () => string }
  ): Promise<{ command: DeploymentCommandRecord; applied: boolean } | null>;
  projectTerminal(
    commandId: string,
    agentId: string,
    expectedState: "completed" | "failed" | "cancelled",
    projection: DeploymentLifecycleProjection
  ): Promise<{ command: DeploymentCommandRecord; applied: boolean } | null>;
};

// =====================================================================
// Public helpers around the deployment command state machine.
//
// The state machine is intentionally strict: only the documented
// transitions are accepted, every other request returns the existing
// row unchanged. This keeps the API surface idempotent and lets
// later slices (cancel / restart / rollback UI) reuse the same rules.
// =====================================================================

const ALLOWED_COMMAND_TRANSITIONS: Readonly<Record<DeploymentCommandState, ReadonlyArray<DeploymentCommandState>>> = {
  pending: ["claimed", "cancelled", "failed"],
  claimed: ["executing", "completed", "failed", "cancelled"],
  executing: ["completed", "failed"],
  completed: [],
  cancelled: [],
  failed: []
};

export function isDeploymentCommandTransitionAllowed(from: DeploymentCommandState, to: DeploymentCommandState): boolean {
  if (from === to) return true;
  return ALLOWED_COMMAND_TRANSITIONS[from].includes(to);
}

export class IllegalDeploymentCommandTransitionError extends Error {
  constructor(public readonly from: DeploymentCommandState, public readonly to: DeploymentCommandState, public readonly commandId: string) {
    super(`Illegal deployment command transition for ${commandId}: ${from} -> ${to}`);
    this.name = "IllegalDeploymentCommandTransitionError";
  }
}

export type ProjectRepository = {
  save(project: Project): Promise<Project>;
  findById(id: string): Promise<Project | null>;
  list(): Promise<Project[]>;
  remove(id: string): Promise<boolean>;
};

export type EnvVariableMetadataRecord = EnvVariableMetadata;

export type EnvVariableMetadataRepository = {
  listByProject(projectId: string): Promise<EnvVariableMetadataRecord[]>;
  upsert(record: EnvVariableMetadataRecord): Promise<EnvVariableMetadataRecord>;
  remove(projectId: string, key: string, scope: EnvVariableMetadataRecord["scope"]): Promise<boolean>;
};

export type EnvSecretValueRecord = EnvSecretValue;

export type EnvSecretValueInput = {
  projectId: string;
  key: string;
  scope: EnvSecretValueRecord["scope"];
  encryptedValue: Buffer;
  valueFingerprint: string;
  keyVersion: number;
};

export type EncryptedEnvSecretMaterial = EnvSecretValueInput;

/** Internal-only encrypted materialization port. Public env repositories never expose ciphertext. */
export type EnvSecretMaterializationRepository = {
  listEncryptedByProject(projectId: string): Promise<EncryptedEnvSecretMaterial[]>;
};

export type EnvSecretValueRepository = {
  listByProject(projectId: string): Promise<EnvSecretValueRecord[]>;
  upsert(record: EnvSecretValueInput): Promise<EnvSecretValueRecord>;
  remove(projectId: string, key: string, scope: EnvSecretValueRecord["scope"]): Promise<boolean>;
};

export type UserRepository = {
  findByEmail(email: string): Promise<ScaffoldUser | null>;
};

export type AuthUserRepository = {
  findByEmail(email: string): Promise<AuthUser | null>;
  findById(id: string): Promise<AuthUser | null>;
  count(): Promise<number>;
  createInitialAdmin(input: CreateInitialAdminInput): Promise<AuthUser>;
};

export class InitialAdminAlreadyExistsError extends Error {
  constructor() {
    super("Initial admin already exists");
    this.name = "InitialAdminAlreadyExistsError";
  }
}

export type RoleRepository = {
  findByName(name: CanonicalRoleName): Promise<AuthRole | null>;
  list(): Promise<AuthRole[]>;
};

export type SessionRepository = {
  create(input: CreateSessionInput): Promise<AuthSession>;
  findValidByTokenHash(tokenHash: string, now?: Date): Promise<AuthSession | null>;
  revoke(sessionId: string, now?: Date): Promise<AuthSession | null>;
};

export type AuditRepository = {
  append(input: AuditEventInput): Promise<AuditEvent>;
  list(filter?: AuditEventListFilter): Promise<AuditEventListPage>;
};

export type PasswordHasher = {
  hash(password: string): Promise<string>;
  verify(password: string, hash: string): Promise<boolean>;
};

export function assertCanonicalRole(role: string): asserts role is CanonicalRoleName {
  if (!canonicalRoleNames.includes(role as CanonicalRoleName)) {
    throw new Error("Unsupported canonical role");
  }
}

export function toSafeAuthUser(user: AuthUser): SafeAuthUser {
  const { passwordHash: _passwordHash, ...safeUser } = user;
  return safeUser;
}

export async function authenticateLocalUser(
  users: AuthUserRepository,
  hasher: PasswordHasher,
  email: string,
  password: string
): Promise<SafeAuthUser | null> {
  const user = await users.findByEmail(email);
  if (!user || user.status !== "active") {
    return null;
  }

  assertCanonicalRole(user.role);

  const passwordMatches = await hasher.verify(password, user.passwordHash);
  return passwordMatches ? toSafeAuthUser(user) : null;
}

export async function getBootstrapStatus(users: AuthUserRepository): Promise<{ setupRequired: boolean }> {
  return { setupRequired: (await users.count()) === 0 };
}

const STALE_AFTER_MS = 60_000;

export const DEPLOYMENT_COMMAND_LEASE_MS = 30_000;
export const DEPLOYMENT_COMMAND_LEASE_RENEWAL_MS = 10_000;

export class InMemoryAgentRepository implements AgentRepository {
  readonly #agents = new Map<string, Agent>();

  async save(agent: Agent): Promise<Agent> {
    this.#agents.set(agent.id, structuredClone(agent));
    return agent;
  }

  async findById(id: string): Promise<Agent | null> {
    return this.#agents.get(id) ?? null;
  }

  async list(): Promise<Agent[]> {
    return [...this.#agents.values()];
  }
}

export class AgentStatusService {
  constructor(private readonly agents: AgentRepository) {}

  async recordHeartbeat(heartbeat: AgentHeartbeat, receivedAt = new Date()): Promise<Agent> {
    const existing = await this.agents.findById(heartbeat.agentId);
    if (!existing) {
      throw new Error("Agent is not registered");
    }

    const updated: Agent = {
      ...existing,
      status: "online",
      lastHeartbeatAt: receivedAt.toISOString(),
      resourceSnapshot: heartbeat.resourceSnapshot
    };
    return this.agents.save(updated);
  }

  markStale(agent: Agent, now = new Date()): Agent {
    if (!agent.lastHeartbeatAt) {
      return { ...agent, status: "offline" };
    }

    const ageMs = now.getTime() - new Date(agent.lastHeartbeatAt).getTime();
    return ageMs > STALE_AFTER_MS ? { ...agent, status: "stale" } : agent;
  }
}

export type EnvMaterializedEntry = {
  projectId: string;
  agentId: string;
  contents: string;
  lines: string[];
};

export type EncryptedEnvRecord = {
  key: string;
  scope: "project" | "deployment";
  encryptedValue: Buffer;
  valueFingerprint: string;
  keyVersion: number;
};

export type MaterializeDeployOptions = {
  projectId: string;
  agentId: string;
  records: EncryptedEnvRecord[];
  cipher?: EnvSecretCipher;
  env?: NodeJS.ProcessEnv;
};

export function buildDeployEnvFile(records: EncryptedEnvRecord[], cipher: EnvSecretCipher): EnvMaterializedEntry {
  const sorted = [...records].sort((left, right) => left.scope === right.scope ? left.key.localeCompare(right.key) : left.scope === "project" ? -1 : 1);
  const lines = sorted.map((record) => {
    if (!Buffer.isBuffer(record.encryptedValue) || record.encryptedValue.length === 0) {
      throw new EnvSecretCipherError(`record ${record.key} is missing an encryptedValue buffer`);
    }
    return `${record.key}=${cipher.decrypt(record.encryptedValue.toString("base64"))}`;
  });
  return { projectId: "", agentId: "", contents: lines.join("\n") + (lines.length ? "\n" : ""), lines };
}

export function materializeMockDeploy(options: MaterializeDeployOptions): EnvMaterializedEntry {
  let cipher = options.cipher;
  if (!cipher) {
    const raw = options.env?.DEPLOYLITE_SECRET_KEY;
    if (!raw?.trim()) throw new EnvSecretKeyMissingError("DEPLOYLITE_SECRET_KEY is missing or empty");
    cipher = createEnvSecretCipher(loadEnvSecretKey(raw));
  }
  return { ...buildDeployEnvFile(options.records, cipher), projectId: options.projectId, agentId: options.agentId };
}

const ENV_NEW_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}=/;
export function redactEnvFileForLog(contents: string): string {
  const redacted: string[] = [];
  let multiline = false;
  for (const line of contents.split("\n")) {
    if (multiline) {
      redacted.push("[REDACTED]");
      if (/^-----END [A-Z0-9 ]+-----\r?$/.test(line)) multiline = false;
      continue;
    }
    const equalsIndex = line.indexOf("=");
    if (equalsIndex < 0) {
      redacted.push(redactSecrets(line));
      continue;
    }
    redacted.push(`${line.slice(0, equalsIndex)}=[REDACTED]`);
    if (equalsIndex > 0 && ENV_NEW_KEY_PATTERN.test(line)) multiline = /^-----BEGIN [A-Z0-9 ]+-----\r?$/.test(line.slice(equalsIndex + 1));
  }
  return redacted.join("\n");
}

const SAFE_DEPLOYMENT_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
export function deploymentContainerName(projectSlug: string, commandId: string): string {
  if (!SAFE_DEPLOYMENT_ID.test(projectSlug) || !SAFE_DEPLOYMENT_ID.test(commandId)) throw new Error("Invalid project slug or command id");
  return `deploylite-${commandId}`;
}

export class InMemoryDeploymentRepository implements DeploymentRepository {
  readonly #deployments = new Map<string, Deployment>();
  readonly #logs = new Map<string, LogEvent[]>();
  readonly #nextLogSequence = new Map<string, number>();

  async save(deployment: Deployment): Promise<Deployment> {
    this.#deployments.set(deployment.id, structuredClone(deployment));
    return deployment;
  }

  async findById(id: string): Promise<Deployment | null> {
    return this.#deployments.get(id) ?? null;
  }

  async list(): Promise<Deployment[]> {
    return [...this.#deployments.values()];
  }

  async appendLog(event: LogEvent): Promise<LogEvent> {
    const safeEvent = { ...event, message: redactLogMessage(event.message), redactionApplied: true };
    const events = this.#logs.get(event.deploymentId) ?? [];
    if (events.some((existing) => existing.sequence === event.sequence)) {
      throw new Error("Log sequences are immutable and unique per deployment");
    }
    this.#logs.set(event.deploymentId, [...events, safeEvent]);
    this.#nextLogSequence.set(event.deploymentId, Math.max(this.#nextLogSequence.get(event.deploymentId) ?? 1, event.sequence + 1));
    return safeEvent;
  }

  async appendAllocatedLog(event: Omit<LogEvent, "sequence">): Promise<LogEvent> {
    const sequence = this.#nextLogSequence.get(event.deploymentId) ?? 1;
    this.#nextLogSequence.set(event.deploymentId, sequence + 1);
    return this.appendLog({ ...event, sequence });
  }

  async listLogs(deploymentId: string, afterSequence = -1): Promise<LogEvent[]> {
    return (this.#logs.get(deploymentId) ?? []).filter((event) => event.sequence > afterSequence);
  }

  snapshotLifecycle(deploymentId: string): { deployment: Deployment | undefined; logs: LogEvent[] | undefined; nextSequence: number | undefined } {
    return {
      deployment: this.#deployments.get(deploymentId) ? structuredClone(this.#deployments.get(deploymentId)) : undefined,
      logs: this.#logs.get(deploymentId) ? structuredClone(this.#logs.get(deploymentId)) : undefined,
      nextSequence: this.#nextLogSequence.get(deploymentId)
    };
  }

  restoreLifecycle(deploymentId: string, snapshot: { deployment: Deployment | undefined; logs: LogEvent[] | undefined; nextSequence: number | undefined }): void {
    if (snapshot.deployment) this.#deployments.set(deploymentId, snapshot.deployment); else this.#deployments.delete(deploymentId);
    if (snapshot.logs) this.#logs.set(deploymentId, snapshot.logs); else this.#logs.delete(deploymentId);
    if (snapshot.nextSequence) this.#nextLogSequence.set(deploymentId, snapshot.nextSequence); else this.#nextLogSequence.delete(deploymentId);
  }
}

export class InMemoryDeploymentCommandRepository implements DeploymentCommandRepository, DeploymentCommandTerminalProjectionRepository {
  readonly #commands = new Map<string, DeploymentCommandRecord>();
  readonly #projectedAudits = new Set<string>();
  #critical: Promise<void> = Promise.resolve();
  readonly #projection?: {
    deployments: InMemoryDeploymentRepository;
    audit: AuditRepository;
    now: () => Date;
    beforeProject?: () => Promise<void>;
  };

  constructor(projection?: { deployments: InMemoryDeploymentRepository; audit: AuditRepository; now: () => Date; beforeProject?: () => Promise<void> }) {
    this.#projection = projection;
  }

  async save(command: DeploymentCommandRecord): Promise<DeploymentCommandRecord> {
    const clone = structuredClone(command);
    this.#commands.set(clone.id, clone);
    return clone;
  }

  async claim(commandId: string, agentId: string, claimedAt: string, leaseExpiresAt: string): Promise<DeploymentCommandRecord | null> {
    const existing = this.#commands.get(commandId);
    if (!existing || existing.agentId !== agentId || existing.state !== "pending") return null;
    return this.save({ ...existing, state: "claimed", claimedAt, leaseExpiresAt });
  }

  async reserveExecution(commandId: string, agentId: string, now: string): Promise<DeploymentCommandRecord | null> {
    return this.#withinCritical(async () => {
      const existing = this.#commands.get(commandId);
      if (!existing || existing.agentId !== agentId || existing.state !== "claimed" || !existing.leaseExpiresAt || existing.leaseExpiresAt <= now) return null;
      return this.save({ ...existing, state: "executing" });
    });
  }

  async renewLease(commandId: string, agentId: string, now: string, leaseExpiresAt: string): Promise<DeploymentCommandRecord | null> {
    const existing = this.#commands.get(commandId);
    if (!existing || existing.agentId !== agentId || (existing.state !== "claimed" && existing.state !== "executing") || !existing.leaseExpiresAt || existing.leaseExpiresAt <= now) return null;
    return this.save({ ...existing, leaseExpiresAt });
  }

  async transitionTerminal(
    commandId: string,
    agentId: string,
    expectedState: "pending" | "claimed" | "executing",
    next: Pick<DeploymentCommandRecord, "state" | "completedAt" | "leaseExpiresAt" | "failureReason" | "payload">,
    condition?: { leaseExpiresAtNotAfterNow: () => string } | { leaseExpiresAtAfterNow: () => string }
  ): Promise<{ command: DeploymentCommandRecord; applied: boolean } | null> {
    const existing = this.#commands.get(commandId);
    if (!existing || existing.agentId !== agentId) return null;
    if (existing.state !== expectedState) return { command: structuredClone(existing), applied: false };
    if (condition) {
      if ("leaseExpiresAtNotAfterNow" in condition && (!existing.leaseExpiresAt || existing.leaseExpiresAt > condition.leaseExpiresAtNotAfterNow())) {
        return { command: structuredClone(existing), applied: false };
      }
      if ("leaseExpiresAtAfterNow" in condition && (!existing.leaseExpiresAt || existing.leaseExpiresAt <= condition.leaseExpiresAtAfterNow())) {
        return { command: structuredClone(existing), applied: false };
      }
    }
    const command = structuredClone({ ...existing, ...next });
    this.#commands.set(command.id, command);
    return { command: structuredClone(command), applied: true };
  }

  async projectRunning(commandId: string, agentId: string, projection: DeploymentLifecycleProjection): Promise<{ command: DeploymentCommandRecord; applied: boolean } | null> {
    if (!this.#projection) {
      throw new Error("In-memory lifecycle projection requires deployment and audit repositories");
    }

    await this.#projection.beforeProject?.();
    return this.#withinCritical(async () => {
      const command = this.#commands.get(commandId);
      if (!command || command.agentId !== agentId) return null;
      if (command.state !== "claimed" || !command.leaseExpiresAt || command.leaseExpiresAt <= this.#projection!.now().toISOString()) {
        return { command: structuredClone(command), applied: false };
      }

      const commandSnapshot = structuredClone(command);
      const snapshot = this.#projection!.deployments.snapshotLifecycle(projection.deployment.id);
      try {
        const existingLogs = await this.#projection!.deployments.listLogs(projection.deployment.id);
        const safeMessage = redactLogMessage(projection.log.message);
        if (existingLogs.some((log) => log.requestId === projection.log.requestId && log.correlationId === projection.log.correlationId)) {
          return { command: structuredClone(command), applied: false };
        }
        const executing = structuredClone({ ...command, state: "executing" as const });
        this.#commands.set(commandId, executing);
        await this.#projection!.deployments.save(projection.deployment);
        await this.#projection!.deployments.appendAllocatedLog({ ...projection.log, message: safeMessage, redactionApplied: true });
        const auditKey = `${projection.audit.action}:${projection.audit.targetType}:${projection.audit.targetId}:${projection.audit.requestId}:${projection.audit.correlationId}`;
        if (!this.#projectedAudits.has(auditKey)) {
          await this.#projection!.audit.append({ ...projection.audit, metadata: redactSecrets(projection.audit.metadata ?? {}) as Record<string, unknown> });
          this.#projectedAudits.add(auditKey);
        }
      } catch (error) {
        this.#commands.set(commandId, commandSnapshot);
        this.#projection!.deployments.restoreLifecycle(projection.deployment.id, snapshot);
        throw error;
      }
      return { command: structuredClone(this.#commands.get(commandId)!), applied: true };
    });
  }

  async projectTerminal(
    commandId: string,
    agentId: string,
    expectedState: "completed" | "failed" | "cancelled",
    projection: DeploymentLifecycleProjection
  ): Promise<{ command: DeploymentCommandRecord; applied: boolean } | null> {
    if (!this.#projection) throw new Error("In-memory lifecycle projection requires deployment and audit repositories");
    return this.#withinCritical(async () => {
      const command = this.#commands.get(commandId);
      if (!command || command.agentId !== agentId) return null;
      if (command.state !== expectedState) return { command: structuredClone(command), applied: false };
      const safeMessage = redactLogMessage(projection.log.message);
      const existingLogs = await this.#projection!.deployments.listLogs(projection.deployment.id);
      const hasTerminalLog = existingLogs.some((log) =>
        log.requestId === projection.log.requestId &&
        log.correlationId === projection.log.correlationId &&
        log.level === projection.log.level &&
        log.message === safeMessage
      );
      const auditKey = `${projection.audit.action}:${projection.audit.targetType}:${projection.audit.targetId}:${projection.audit.requestId}:${projection.audit.correlationId}`;
      const existingDeployment = await this.#projection!.deployments.findById(projection.deployment.id);
      if (hasTerminalLog && this.#projectedAudits.has(auditKey) && existingDeployment?.status === projection.deployment.status) {
        return { command: structuredClone(command), applied: false };
      }
      const snapshot = this.#projection!.deployments.snapshotLifecycle(projection.deployment.id);
      try {
        await this.#projection!.deployments.save(projection.deployment);
        if (!hasTerminalLog) {
          await this.#projection!.deployments.appendAllocatedLog({ ...projection.log, message: safeMessage, redactionApplied: true });
        }
        if (!this.#projectedAudits.has(auditKey)) {
          await this.#projection!.audit.append({ ...projection.audit, metadata: redactSecrets(projection.audit.metadata ?? {}) as Record<string, unknown> });
          this.#projectedAudits.add(auditKey);
        }
      } catch (error) {
        this.#projection!.deployments.restoreLifecycle(projection.deployment.id, snapshot);
        throw error;
      }
      return { command: structuredClone(command), applied: true };
    });
  }

  async transitionTerminalAndProject(
    commandId: string,
    agentId: string,
    expectedState: "pending" | "claimed" | "executing",
    next: Pick<DeploymentCommandRecord, "state" | "completedAt" | "leaseExpiresAt" | "failureReason" | "payload">,
    projection: DeploymentLifecycleProjection,
    condition?: { leaseExpiresAtNotAfterNow: () => string } | { leaseExpiresAtAfterNow: () => string }
  ): Promise<{ command: DeploymentCommandRecord; applied: boolean } | null> {
    if (!this.#projection) throw new Error("In-memory lifecycle projection requires deployment and audit repositories");
    return this.#withinCritical(async () => {
      const current = this.#commands.get(commandId);
      if (!current || current.agentId !== agentId) return null;
      const now = this.#projection!.now().getTime();
      const lease = current.leaseExpiresAt ? new Date(current.leaseExpiresAt).getTime() : Number.NaN;
      const leaseMatches = !condition || ("leaseExpiresAtNotAfterNow" in condition ? lease <= now : lease > now);
      if (current.state !== expectedState || !leaseMatches) return { command: structuredClone(current), applied: false };
      const snapshot = this.#projection!.deployments.snapshotLifecycle(projection.deployment.id);
      const original = structuredClone(current);
      const command = { ...current, ...next };
      try {
        this.#commands.set(commandId, command);
        await this.#projection!.deployments.save(projection.deployment);
        await this.#projection!.deployments.appendAllocatedLog({ ...projection.log, message: redactLogMessage(projection.log.message), redactionApplied: true });
        const auditKey = `${projection.audit.action}:${projection.audit.targetType}:${projection.audit.targetId}:${projection.audit.requestId}:${projection.audit.correlationId}`;
        if (!this.#projectedAudits.has(auditKey)) {
          await this.#projection!.audit.append({ ...projection.audit, metadata: redactSecrets(projection.audit.metadata ?? {}) as Record<string, unknown> });
          this.#projectedAudits.add(auditKey);
        }
      } catch (error) {
        this.#commands.set(commandId, original);
        this.#projection!.deployments.restoreLifecycle(projection.deployment.id, snapshot);
        throw error;
      }
      return { command: structuredClone(command), applied: true };
    });
  }

  async cancel(commandId: string, requestedBy: string | null, now: string): Promise<{ command: DeploymentCommandRecord; applied: boolean } | null> {
    return this.#withinCritical(async () => {
      const command = this.#commands.get(commandId);
      if (!command) return null;
      if (command.state !== "pending" && command.state !== "claimed") return { command: structuredClone(command), applied: false };
      const cancelled = structuredClone({ ...command, state: "cancelled" as const, requestedBy, completedAt: now, leaseExpiresAt: null });
      this.#commands.set(commandId, cancelled);
      return { command: structuredClone(cancelled), applied: true };
    });
  }

  async #withinCritical<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#critical;
    let release: (() => void) | undefined;
    this.#critical = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release?.();
    }
  }

  async findById(id: string): Promise<DeploymentCommandRecord | null> {
    const existing = this.#commands.get(id);
    return existing ? structuredClone(existing) : null;
  }

  async findActiveForDeployment(deploymentId: string): Promise<DeploymentCommandRecord | null> {
    for (const command of this.#commands.values()) {
      if (command.deploymentId === deploymentId && (command.state === "pending" || command.state === "claimed" || command.state === "executing")) {
        return structuredClone(command);
      }
    }
    return null;
  }

  async list(): Promise<DeploymentCommandRecord[]> {
    return [...this.#commands.values()].map((command) => structuredClone(command));
  }
}

export class InMemoryEnvVariableMetadataRepository implements EnvVariableMetadataRepository {
  readonly #records = new Map<string, EnvVariableMetadataRecord>();

  #key(projectId: string, key: string, scope: EnvVariableMetadataRecord["scope"]): string {
    return `${projectId}::${scope}::${key}`;
  }

  async listByProject(projectId: string): Promise<EnvVariableMetadataRecord[]> {
    return [...this.#records.values()].filter((record) => record.projectId === projectId);
  }

  async upsert(record: EnvVariableMetadataRecord): Promise<EnvVariableMetadataRecord> {
    const clone = structuredClone(record);
    this.#records.set(this.#key(record.projectId, record.key, record.scope), clone);
    return clone;
  }

  async remove(projectId: string, key: string, scope: EnvVariableMetadataRecord["scope"]): Promise<boolean> {
    return this.#records.delete(this.#key(projectId, key, scope));
  }
}

export class InMemoryEnvSecretValueRepository implements EnvSecretValueRepository {
  readonly #records = new Map<string, EnvSecretValueRecord>();
  readonly #encryptedRecords = new Map<string, EncryptedEnvSecretMaterial>();
  #seq = 0;

  #key(projectId: string, key: string, scope: EnvSecretValueRecord["scope"]): string {
    return `${projectId}::${scope}::${key}`;
  }

  async listByProject(projectId: string): Promise<EnvSecretValueRecord[]> {
    return [...this.#records.values()]
      .filter((record) => record.projectId === projectId)
      .map((record) => ({ ...record }));
  }

  async upsert(record: EnvSecretValueInput): Promise<EnvSecretValueRecord> {
    if (!Buffer.isBuffer(record.encryptedValue) || record.encryptedValue.length === 0) {
      throw new Error("env secret value encryptedValue must be a non-empty Buffer");
    }
    if (typeof record.valueFingerprint !== "string" || record.valueFingerprint.length === 0) {
      throw new Error("env secret value valueFingerprint must be a non-empty string");
    }
    if (!Number.isInteger(record.keyVersion) || record.keyVersion <= 0) {
      throw new Error("env secret value keyVersion must be a positive integer");
    }
    const now = new Date().toISOString();
    const existing = this.#records.get(this.#key(record.projectId, record.key, record.scope));
    const next: EnvSecretValueRecord = {
      id: existing?.id ?? `envv_${++this.#seq}`,
      projectId: record.projectId,
      key: record.key,
      scope: record.scope,
      valuePresent: true,
      valueFingerprint: record.valueFingerprint,
      keyVersion: record.keyVersion,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    };
    this.#records.set(this.#key(record.projectId, record.key, record.scope), next);
    this.#encryptedRecords.set(this.#key(record.projectId, record.key, record.scope), {
      ...record,
      encryptedValue: Buffer.from(record.encryptedValue)
    });
    return { ...next };
  }

  async listEncryptedByProject(projectId: string): Promise<EncryptedEnvSecretMaterial[]> {
    return [...this.#encryptedRecords.values()]
      .filter((record) => record.projectId === projectId)
      .map((record) => ({ ...record, encryptedValue: Buffer.from(record.encryptedValue) }));
  }

  async remove(projectId: string, key: string, scope: EnvSecretValueRecord["scope"]): Promise<boolean> {
    const recordKey = this.#key(projectId, key, scope);
    this.#encryptedRecords.delete(recordKey);
    return this.#records.delete(recordKey);
  }
}

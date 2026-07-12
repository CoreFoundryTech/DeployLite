import { and, count as sqlCount, desc, eq, gt, isNull, like, or, sql } from "drizzle-orm";
import { redactSecrets } from "@deploylite/config";
import type {
  AuditEvent,
  AuditEventInput,
  AuditEventListFilter,
  AuditEventListItem,
  AuditEventListPage,
  AuditRepository,
  AuthRole,
  AuthSession,
  AuthUser,
  AuthUserRepository,
  CanonicalRoleName,
  CreateInitialAdminInput,
  CreateSessionInput,
  RoleRepository,
  SessionRepository
} from "@deploylite/domain";
import { assertCanonicalRole, InitialAdminAlreadyExistsError } from "@deploylite/domain";

import type { DeployLiteDb } from "../client.js";
import { auditEvents, roles, userSessions, users, type AuditEventRow, type Role, type User, type UserSession } from "../schema.js";

export class DbRoleRepository implements RoleRepository {
  constructor(private readonly db: DeployLiteDb) {}

  async findByName(name: CanonicalRoleName): Promise<AuthRole | null> {
    const [role] = await this.db.select().from(roles).where(eq(roles.name, name)).limit(1);
    return role ? toAuthRole(role) : null;
  }

  async list(): Promise<AuthRole[]> {
    const rows = await this.db.select().from(roles).orderBy(roles.name);
    return rows.map(toAuthRole);
  }
}

export class DbAuthUserRepository implements AuthUserRepository {
  constructor(private readonly db: DeployLiteDb) {}

  async findByEmail(email: string): Promise<AuthUser | null> {
    const [row] = await this.db
      .select({ user: users, role: roles })
      .from(users)
      .innerJoin(roles, eq(users.roleId, roles.id))
      .where(eq(users.emailNormalized, normalizeEmail(email)))
      .limit(1);

    return row ? toAuthUser(row.user, row.role) : null;
  }

  async findById(id: string): Promise<AuthUser | null> {
    const [row] = await this.db
      .select({ user: users, role: roles })
      .from(users)
      .innerJoin(roles, eq(users.roleId, roles.id))
      .where(eq(users.id, id))
      .limit(1);

    return row ? toAuthUser(row.user, row.role) : null;
  }

  async count(): Promise<number> {
    const [row] = await this.db.select({ count: sqlCount() }).from(users);
    return row?.count ?? 0;
  }

  async createInitialAdmin(input: CreateInitialAdminInput): Promise<AuthUser> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('deploylite.initial_admin_bootstrap'))`);

      const [countRow] = await tx.select({ count: sqlCount() }).from(users);
      if ((countRow?.count ?? 0) > 0) {
        throw new InitialAdminAlreadyExistsError();
      }

      const [adminRole] = await tx.select().from(roles).where(eq(roles.name, "admin")).limit(1);
      if (!adminRole) {
        throw new Error("Canonical admin role is missing");
      }

      const [created] = await tx
        .insert(users)
        .values({
          email: input.email,
          emailNormalized: normalizeEmail(input.email),
          passwordHash: input.passwordHash,
          roleId: adminRole.id,
          status: "active"
        })
        .returning();

      if (!created) {
        throw new Error("Failed to create initial admin");
      }

      return toAuthUser(created, adminRole);
    });
  }
}

export class DbSessionRepository implements SessionRepository {
  constructor(private readonly db: DeployLiteDb) {}

  async create(input: CreateSessionInput): Promise<AuthSession> {
    const [created] = await this.db
      .insert(userSessions)
      .values({
        userId: input.userId,
        tokenHash: input.tokenHash,
        expiresAt: input.expiresAt,
        ipHash: input.ipHash ?? null,
        userAgent: input.userAgent ?? null
      })
      .returning();

    if (!created) {
      throw new Error("Failed to create session");
    }

    return toAuthSession(created);
  }

  async findValidByTokenHash(tokenHash: string, now = new Date()): Promise<AuthSession | null> {
    const [session] = await this.db
      .select()
      .from(userSessions)
      .where(and(eq(userSessions.tokenHash, tokenHash), gt(userSessions.expiresAt, now), isNull(userSessions.revokedAt)))
      .limit(1);

    return session ? toAuthSession(session) : null;
  }

  async revoke(sessionId: string, now = new Date()): Promise<AuthSession | null> {
    const [revoked] = await this.db.update(userSessions).set({ revokedAt: now }).where(eq(userSessions.id, sessionId)).returning();
    return revoked ? toAuthSession(revoked) : null;
  }
}

const MAX_DB_AUDIT_LIMIT = 200;
const DEFAULT_DB_AUDIT_LIMIT = 50;
const MAX_DB_AUDIT_OFFSET = 10_000;

export class DbAuditRepository implements AuditRepository {
  constructor(private readonly db: DeployLiteDb) {}

  async append(input: AuditEventInput): Promise<AuditEvent> {
    const [created] = await this.db
      .insert(auditEvents)
      .values(toAuditEventInsert(input))
      .returning();

    if (!created) {
      throw new Error("Failed to append audit event");
    }

    return toAuditEvent(created);
  }

  async appendOnce(input: AuditEventInput, id: string): Promise<AuditEvent> {
    const [created] = await this.db
      .insert(auditEvents)
      .values({ id, ...toAuditEventInsert(input) })
      .onConflictDoNothing()
      .returning();

    if (created) return toAuditEvent(created);

    // `audit_events.id` is the primary key, so ON CONFLICT means another
    // writer already durably owns this idempotency key. Return that event
    // rather than reporting a duplicate as a failed audit write.
    const [existing] = await this.db.select().from(auditEvents).where(eq(auditEvents.id, id)).limit(1);
    if (existing) {
      return toAuditEvent(existing);
    }

    throw new Error("Failed to append idempotent audit event");
  }

  async list(filter: AuditEventListFilter = {}): Promise<AuditEventListPage> {
    const limit = clampDbLimit(filter.limit);
    const offset = clampDbOffset(filter.offset);
    const conditions = [];
    if (filter.actorUserId) {
      conditions.push(eq(auditEvents.actorUserId, filter.actorUserId));
    }
    if (filter.action) {
      // action filter is a prefix match (e.g. "project.env-value") so the
      // client can scope to a logical group without enumerating every action.
      conditions.push(like(auditEvents.action, `${filter.action}%`));
    }
    if (filter.projectId) {
      const targetId = `${filter.projectId}`;
      const targetPrefix = `${filter.projectId}:`;
      // Either the row's target_id is the project id directly, or it starts
      // with `<projectId>:` (the convention used for env-value and
      // env-metadata actions), or the JSON metadata column carries a
      // `projectId` property (used by events whose target_id is opaque, e.g.
      // the env_secret_values row id).
      const targetCondition = or(eq(auditEvents.targetId, targetId), like(auditEvents.targetId, `${targetPrefix}%`));
      const metadataCondition = sql`${auditEvents.metadata} ->> 'projectId' = ${filter.projectId}`;
      conditions.push(or(targetCondition, metadataCondition));
    }
    const where = conditions.length === 0 ? undefined : conditions.length === 1 ? conditions[0] : and(...conditions);

    const [rows, totalRow] = await Promise.all([
      this.db
        .select()
        .from(auditEvents)
        .where(where)
        .orderBy(desc(auditEvents.createdAt))
        .limit(limit)
        .offset(offset),
      this.db
        .select({ value: sqlCount() })
        .from(auditEvents)
        .where(where)
    ]);

    const total = Number(totalRow[0]?.value ?? 0);
    return {
      events: rows.map(toAuditListItem),
      total,
      limit,
      offset
    };
  }
}

function clampDbLimit(raw: number | undefined): number {
  if (raw === undefined) return DEFAULT_DB_AUDIT_LIMIT;
  if (!Number.isInteger(raw) || raw < 1) return 1;
  if (raw > MAX_DB_AUDIT_LIMIT) return MAX_DB_AUDIT_LIMIT;
  return raw;
}

function clampDbOffset(raw: number | undefined): number {
  if (raw === undefined) return 0;
  if (!Number.isInteger(raw) || raw < 0) return 0;
  if (raw > MAX_DB_AUDIT_OFFSET) return MAX_DB_AUDIT_OFFSET;
  return raw;
}

function toAuditListItem(row: AuditEventRow): AuditEventListItem {
  return {
    id: row.id,
    actorId: row.actorUserId === null ? "anonymous" : row.actorUserId ?? "system",
    action: row.action,
    targetType: row.targetType,
    targetId: row.targetId,
    requestId: row.requestId,
    correlationId: row.correlationId,
    timestamp: row.createdAt.toISOString()
  };
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function redactAuditMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  return redactSecrets(metadata);
}

function toAuditEventInsert(input: AuditEventInput) {
  return {
    actorUserId: input.actorUserId ?? null,
    action: input.action,
    targetType: input.targetType,
    targetId: input.targetId,
    requestId: input.requestId,
    correlationId: input.correlationId,
    metadata: redactAuditMetadata(input.metadata ?? {})
  };
}

function toAuthRole(role: Role): AuthRole {
  assertCanonicalRole(role.name);
  return { ...role, name: role.name };
}

function toAuthUser(user: User, role: Role): AuthUser {
  assertCanonicalRole(role.name);
  return {
    id: user.id,
    email: user.email,
    emailNormalized: user.emailNormalized,
    passwordHash: user.passwordHash,
    role: role.name,
    status: user.status === "disabled" ? "disabled" : "active",
    createdAt: user.createdAt,
    updatedAt: user.updatedAt
  };
}

function toAuthSession(session: UserSession): AuthSession {
  return session;
}

function toAuditEvent(row: AuditEventRow): AuditEvent {
  return {
    id: row.id,
    actorId: row.actorUserId === null ? "anonymous" : row.actorUserId ?? "system",
    action: row.action,
    targetType: row.targetType,
    targetId: row.targetId,
    requestId: row.requestId,
    correlationId: row.correlationId,
    timestamp: row.createdAt.toISOString()
  };
}

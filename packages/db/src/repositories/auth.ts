import { and, eq, gt, isNull } from "drizzle-orm";
import { redactSecrets } from "@deploylite/config";
import type {
  AuditEvent,
  AuditEventInput,
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
import { assertCanonicalRole } from "@deploylite/domain";

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

  async createInitialAdmin(input: CreateInitialAdminInput): Promise<AuthUser> {
    const [existingUser] = await this.db.select({ id: users.id }).from(users).limit(1);
    if (existingUser) {
      throw new Error("Initial admin already exists");
    }

    const [adminRole] = await this.db.select().from(roles).where(eq(roles.name, "admin")).limit(1);
    if (!adminRole) {
      throw new Error("Canonical admin role is missing");
    }

    const [created] = await this.db
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

export class DbAuditRepository implements AuditRepository {
  constructor(private readonly db: DeployLiteDb) {}

  async append(input: AuditEventInput): Promise<AuditEvent> {
    const [created] = await this.db
      .insert(auditEvents)
      .values({
        actorUserId: input.actorUserId ?? null,
        action: input.action,
        targetType: input.targetType,
        targetId: input.targetId,
        requestId: input.requestId,
        correlationId: input.correlationId,
        metadata: redactAuditMetadata(input.metadata ?? {})
      })
      .returning();

    if (!created) {
      throw new Error("Failed to append audit event");
    }

    return toAuditEvent(created);
  }
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function redactAuditMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  return redactSecrets(metadata);
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
    actorId: row.actorUserId ?? "system",
    action: row.action,
    targetType: row.targetType,
    targetId: row.targetId,
    requestId: row.requestId,
    correlationId: row.correlationId,
    timestamp: row.createdAt.toISOString()
  };
}

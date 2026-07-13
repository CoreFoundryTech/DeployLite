import { and, asc, desc, eq, gt, inArray, lte, sql } from "drizzle-orm";
import { redactLogMessage, redactSecrets } from "@deploylite/config";
import type { DeploymentCommandKind, DeploymentCommandState } from "@deploylite/contracts";
import type {
  DeploymentCommandBusSubmitInput,
  DeploymentCommandEventType,
  DeploymentCommandRecord,
  DeploymentCommandRepository,
  DeploymentCommandProjectionRepository,
  DeploymentCommandTerminalProjectionRepository,
  DeploymentLifecycleProjection
} from "@deploylite/domain";

import type { DeployLiteDb } from "../client.js";
import { auditEvents, deploymentCommands, deploymentLogSequences, deploymentLogs, deployments, agents, type DeploymentCommandRow, type NewDeploymentCommandRow } from "../schema.js";

const TERMINAL_STATES: ReadonlyArray<DeploymentCommandState> = ["completed", "cancelled", "failed"];

const ACTIVE_STATES: ReadonlyArray<DeploymentCommandState> = ["pending", "claimed", "executing"];

// Test-only synchronization point for proving a competing cancellation wins.
type ProjectRunningTestHooks = {
  afterFenceRead?: () => Promise<void>;
};

export class DbDeploymentCommandRepository implements DeploymentCommandRepository, DeploymentCommandProjectionRepository, DeploymentCommandTerminalProjectionRepository {
  constructor(private readonly db: DeployLiteDb, private readonly testHooks?: ProjectRunningTestHooks) {}

  async save(command: DeploymentCommandRecord): Promise<DeploymentCommandRecord> {
    // Defensive FK check: refuse to write a command whose deployment or
    // agent no longer exists. The migration's FKs would throw on insert,
    // but the wrapped error would be opaque; a precondition check makes
    // the failure path readable for tests and for the API.
    const deployment = await this.db.select({ id: deployments.id }).from(deployments).where(eq(deployments.id, command.deploymentId)).limit(1);
    if (deployment.length === 0) {
      throw new Error(`Cannot persist deployment command for missing deployment ${command.deploymentId}`);
    }
    const agent = await this.db.select({ id: agents.id }).from(agents).where(eq(agents.id, command.agentId)).limit(1);
    if (agent.length === 0) {
      throw new Error(`Cannot persist deployment command for missing agent ${command.agentId}`);
    }

    const values: NewDeploymentCommandRow = {
      id: command.id,
      deploymentId: command.deploymentId,
      agentId: command.agentId,
      kind: command.kind,
      state: command.state,
      payload: command.payload,
      requestedBy: command.requestedBy,
      requestId: command.requestId,
      correlationId: command.correlationId,
      issuedAt: new Date(command.issuedAt),
      claimedAt: command.claimedAt ? new Date(command.claimedAt) : null,
      leaseExpiresAt: command.leaseExpiresAt ? new Date(command.leaseExpiresAt) : null,
      completedAt: command.completedAt ? new Date(command.completedAt) : null,
      failureReason: command.failureReason
    };

    const [row] = await this.db
      .insert(deploymentCommands)
      .values(values)
      .onConflictDoUpdate({
        target: deploymentCommands.id,
        set: {
          kind: values.kind,
          state: values.state,
          payload: values.payload,
          requestedBy: values.requestedBy,
          claimedAt: values.claimedAt,
          leaseExpiresAt: values.leaseExpiresAt,
          completedAt: values.completedAt,
          failureReason: values.failureReason,
          updatedAt: new Date()
        }
      })
      .returning();

    if (!row) {
      throw new Error("Failed to save deployment command");
    }

    return toDeploymentCommand(row);
  }

  async findById(id: string): Promise<DeploymentCommandRecord | null> {
    const [row] = await this.db.select().from(deploymentCommands).where(eq(deploymentCommands.id, id)).limit(1);
    return row ? toDeploymentCommand(row) : null;
  }

  async claim(commandId: string, agentId: string, claimedAt: string, leaseExpiresAt: string): Promise<DeploymentCommandRecord | null> {
    const [row] = await this.db.update(deploymentCommands).set({
      state: "claimed",
      claimedAt: new Date(claimedAt),
      leaseExpiresAt: new Date(leaseExpiresAt),
      updatedAt: new Date()
    }).where(and(eq(deploymentCommands.id, commandId), eq(deploymentCommands.agentId, agentId), eq(deploymentCommands.state, "pending"))).returning();
    return row ? toDeploymentCommand(row) : null;
  }

  async renewLease(commandId: string, agentId: string, now: string, leaseExpiresAt: string): Promise<DeploymentCommandRecord | null> {
    const [row] = await this.db.update(deploymentCommands).set({
      leaseExpiresAt: new Date(leaseExpiresAt),
      updatedAt: new Date()
    }).where(and(
      eq(deploymentCommands.id, commandId),
      eq(deploymentCommands.agentId, agentId),
      inArray(deploymentCommands.state, ["claimed", "executing"]),
      gt(deploymentCommands.leaseExpiresAt, new Date(now))
    )).returning();
    return row ? toDeploymentCommand(row) : null;
  }

  async reserveExecution(commandId: string, agentId: string, now: string): Promise<DeploymentCommandRecord | null> {
    const [row] = await this.db.update(deploymentCommands).set({ state: "executing", updatedAt: new Date() }).where(and(
      eq(deploymentCommands.id, commandId),
      eq(deploymentCommands.agentId, agentId),
      eq(deploymentCommands.state, "claimed"),
      gt(deploymentCommands.leaseExpiresAt, new Date(now))
    )).returning();
    return row ? toDeploymentCommand(row) : null;
  }

  async transitionTerminal(
    commandId: string,
    agentId: string,
    expectedState: "pending" | "claimed" | "executing",
    next: Pick<DeploymentCommandRecord, "state" | "completedAt" | "leaseExpiresAt" | "failureReason" | "payload">,
    condition?: { leaseExpiresAtNotAfterNow: () => string } | { leaseExpiresAtAfterNow: () => string }
  ): Promise<{ command: DeploymentCommandRecord; applied: boolean } | null> {
    const [row] = await this.db.update(deploymentCommands).set({
      state: next.state,
      payload: next.payload,
      completedAt: next.completedAt ? new Date(next.completedAt) : null,
      leaseExpiresAt: null,
      failureReason: next.failureReason,
      updatedAt: new Date()
    }).where(and(
      eq(deploymentCommands.id, commandId),
      eq(deploymentCommands.agentId, agentId),
      eq(deploymentCommands.state, expectedState),
      ...(condition && "leaseExpiresAtNotAfterNow" in condition
        ? [lte(deploymentCommands.leaseExpiresAt, sql`clock_timestamp()`)]
        : condition ? [gt(deploymentCommands.leaseExpiresAt, sql`clock_timestamp()`)] : [])
    )).returning();
    if (row) return { command: toDeploymentCommand(row), applied: true };
    const authoritative = await this.findById(commandId);
    return authoritative?.agentId === agentId ? { command: authoritative, applied: false } : null;
  }

  async projectRunning(commandId: string, agentId: string, projection: DeploymentLifecycleProjection): Promise<{ command: DeploymentCommandRecord; applied: boolean } | null> {
    return this.db.transaction(async (tx) => {
      const [observed] = await tx.select().from(deploymentCommands).where(and(
        eq(deploymentCommands.id, commandId),
        eq(deploymentCommands.agentId, agentId)
      )).limit(1);
      if (!observed) return null;
      await this.testHooks?.afterFenceRead?.();

      // This reservation is the fence: it takes the row lock and moves the
      // command to executing in the same transaction as every running effect.
      const [command] = await tx.update(deploymentCommands).set({ state: "executing", updatedAt: sql`clock_timestamp()` }).where(and(
        eq(deploymentCommands.id, commandId),
        eq(deploymentCommands.agentId, agentId),
        eq(deploymentCommands.state, "claimed"),
        gt(deploymentCommands.leaseExpiresAt, sql`clock_timestamp()`)
      )).returning();
      if (!command) {
        const [authoritative] = await tx.select().from(deploymentCommands).where(and(eq(deploymentCommands.id, commandId), eq(deploymentCommands.agentId, agentId))).limit(1);
        return authoritative ? { command: toDeploymentCommand(authoritative), applied: false } : null;
      }

      const [deployment] = await tx.update(deployments).set({
        status: projection.deployment.status,
        startedAt: new Date(projection.deployment.startedAt),
        finishedAt: projection.deployment.finishedAt ? new Date(projection.deployment.finishedAt) : null,
        updatedAt: sql`clock_timestamp()`
      }).where(eq(deployments.id, projection.deployment.id)).returning();
      if (!deployment) throw new Error("Running projection deployment is missing");

      const safeMessage = redactLogMessage(projection.log.message);
      const existingLog = await tx.select({ id: deploymentLogs.id }).from(deploymentLogs).where(and(
        eq(deploymentLogs.deploymentId, projection.log.deploymentId),
        eq(deploymentLogs.requestId, projection.log.requestId),
        eq(deploymentLogs.correlationId, projection.log.correlationId)
      )).limit(1);
      if (existingLog.length > 0) return { command: toDeploymentCommand(command), applied: false };
      if (existingLog.length === 0) {
        const [allocation] = await tx.insert(deploymentLogSequences).values({ deploymentId: projection.log.deploymentId, nextSequence: 2 }).onConflictDoUpdate({
          target: deploymentLogSequences.deploymentId,
          set: { nextSequence: sql`${deploymentLogSequences.nextSequence} + 1` }
        }).returning({ sequence: sql<number>`${deploymentLogSequences.nextSequence} - 1` });
        if (!allocation) throw new Error("Running projection could not allocate a deployment log sequence");
        await tx.insert(deploymentLogs).values({ ...projection.log, sequence: allocation.sequence, message: safeMessage, redactionApplied: true });
      }

      const existingAudit = await tx.select({ id: auditEvents.id }).from(auditEvents).where(and(
        eq(auditEvents.action, projection.audit.action),
        eq(auditEvents.targetType, projection.audit.targetType),
        eq(auditEvents.targetId, projection.audit.targetId),
        eq(auditEvents.requestId, projection.audit.requestId),
        eq(auditEvents.correlationId, projection.audit.correlationId)
      )).limit(1);
      if (existingAudit.length === 0) {
        await tx.insert(auditEvents).values({
          actorUserId: projection.audit.actorUserId ?? null,
          action: projection.audit.action,
          targetType: projection.audit.targetType,
          targetId: projection.audit.targetId,
          requestId: projection.audit.requestId,
          correlationId: projection.audit.correlationId,
          metadata: redactSecrets(projection.audit.metadata ?? {}) as Record<string, unknown>
        });
      }
      return { command: toDeploymentCommand(command), applied: true };
    });
  }

  async projectTerminal(commandId: string, agentId: string, expectedState: "completed" | "failed" | "cancelled", projection: DeploymentLifecycleProjection): Promise<{ command: DeploymentCommandRecord; applied: boolean } | null> {
    return this.db.transaction(async (tx) => {
      // Lock the terminal command so concurrent acknowledgement/recovery calls
      // re-check deduplication after the prior winner's effects commit.
      const [command] = await tx.update(deploymentCommands).set({ updatedAt: sql`clock_timestamp()` }).where(and(
        eq(deploymentCommands.id, commandId), eq(deploymentCommands.agentId, agentId), eq(deploymentCommands.state, expectedState)
      )).returning();
      if (!command) {
        const [authoritative] = await tx.select().from(deploymentCommands).where(and(eq(deploymentCommands.id, commandId), eq(deploymentCommands.agentId, agentId))).limit(1);
        return authoritative ? { command: toDeploymentCommand(authoritative), applied: false } : null;
      }
      const existingLog = await tx.select({ id: deploymentLogs.id }).from(deploymentLogs).where(and(
        eq(deploymentLogs.deploymentId, projection.log.deploymentId), eq(deploymentLogs.requestId, projection.log.requestId), eq(deploymentLogs.correlationId, projection.log.correlationId)
      )).limit(1);
      if (existingLog.length > 0) return { command: toDeploymentCommand(command), applied: false };
      const [deployment] = await tx.update(deployments).set({
        status: projection.deployment.status,
        startedAt: projection.deployment.startedAt ? new Date(projection.deployment.startedAt) : null,
        finishedAt: projection.deployment.finishedAt ? new Date(projection.deployment.finishedAt) : null,
        updatedAt: sql`clock_timestamp()`
      }).where(eq(deployments.id, projection.deployment.id)).returning();
      if (!deployment) throw new Error("Terminal projection deployment is missing");
      const [allocation] = await tx.insert(deploymentLogSequences).values({ deploymentId: projection.log.deploymentId, nextSequence: 2 }).onConflictDoUpdate({
        target: deploymentLogSequences.deploymentId,
        set: { nextSequence: sql`${deploymentLogSequences.nextSequence} + 1` }
      }).returning({ sequence: sql<number>`${deploymentLogSequences.nextSequence} - 1` });
      if (!allocation) throw new Error("Terminal projection could not allocate a deployment log sequence");
      await tx.insert(deploymentLogs).values({ ...projection.log, sequence: allocation.sequence, message: redactLogMessage(projection.log.message), redactionApplied: true });
      const existingAudit = await tx.select({ id: auditEvents.id }).from(auditEvents).where(and(
        eq(auditEvents.action, projection.audit.action), eq(auditEvents.targetType, projection.audit.targetType), eq(auditEvents.targetId, projection.audit.targetId),
        eq(auditEvents.requestId, projection.audit.requestId), eq(auditEvents.correlationId, projection.audit.correlationId)
      )).limit(1);
      if (existingAudit.length === 0) await tx.insert(auditEvents).values({
        actorUserId: projection.audit.actorUserId ?? null, action: projection.audit.action, targetType: projection.audit.targetType,
        targetId: projection.audit.targetId, requestId: projection.audit.requestId, correlationId: projection.audit.correlationId,
        metadata: redactSecrets(projection.audit.metadata ?? {}) as Record<string, unknown>
      });
      return { command: toDeploymentCommand(command), applied: true };
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
    return this.db.transaction(async (tx) => {
      const [command] = await tx.update(deploymentCommands).set({
        state: next.state, payload: next.payload, completedAt: next.completedAt ? new Date(next.completedAt) : null,
        leaseExpiresAt: null, failureReason: next.failureReason, updatedAt: sql`clock_timestamp()`
      }).where(and(
        eq(deploymentCommands.id, commandId), eq(deploymentCommands.agentId, agentId), eq(deploymentCommands.state, expectedState),
        ...(condition && "leaseExpiresAtNotAfterNow" in condition
          ? [lte(deploymentCommands.leaseExpiresAt, sql`clock_timestamp()`)]
          : condition ? [gt(deploymentCommands.leaseExpiresAt, sql`clock_timestamp()`)] : [])
      )).returning();
      if (!command) {
        const [authoritative] = await tx.select().from(deploymentCommands).where(and(eq(deploymentCommands.id, commandId), eq(deploymentCommands.agentId, agentId))).limit(1);
        return authoritative ? { command: toDeploymentCommand(authoritative), applied: false } : null;
      }
      const [deployment] = await tx.update(deployments).set({
        status: projection.deployment.status, startedAt: projection.deployment.startedAt ? new Date(projection.deployment.startedAt) : null,
        finishedAt: projection.deployment.finishedAt ? new Date(projection.deployment.finishedAt) : null, updatedAt: sql`clock_timestamp()`
      }).where(eq(deployments.id, projection.deployment.id)).returning();
      if (!deployment) throw new Error("Terminal projection deployment is missing");
      const [allocation] = await tx.insert(deploymentLogSequences).values({ deploymentId: projection.log.deploymentId, nextSequence: 2 }).onConflictDoUpdate({
        target: deploymentLogSequences.deploymentId, set: { nextSequence: sql`${deploymentLogSequences.nextSequence} + 1` }
      }).returning({ sequence: sql<number>`${deploymentLogSequences.nextSequence} - 1` });
      if (!allocation) throw new Error("Terminal projection could not allocate a deployment log sequence");
      await tx.insert(deploymentLogs).values({ ...projection.log, sequence: allocation.sequence, message: redactLogMessage(projection.log.message), redactionApplied: true });
      const existingAudit = await tx.select({ id: auditEvents.id }).from(auditEvents).where(and(
        eq(auditEvents.action, projection.audit.action), eq(auditEvents.targetType, projection.audit.targetType), eq(auditEvents.targetId, projection.audit.targetId),
        eq(auditEvents.requestId, projection.audit.requestId), eq(auditEvents.correlationId, projection.audit.correlationId)
      )).limit(1);
      if (existingAudit.length === 0) await tx.insert(auditEvents).values({
        actorUserId: projection.audit.actorUserId ?? null, action: projection.audit.action, targetType: projection.audit.targetType,
        targetId: projection.audit.targetId, requestId: projection.audit.requestId, correlationId: projection.audit.correlationId,
        metadata: redactSecrets(projection.audit.metadata ?? {}) as Record<string, unknown>
      });
      return { command: toDeploymentCommand(command), applied: true };
    });
  }

  async cancel(commandId: string, requestedBy: string | null, now: string): Promise<{ command: DeploymentCommandRecord; applied: boolean } | null> {
    const [command] = await this.db.update(deploymentCommands).set({
      state: "cancelled",
      requestedBy,
      completedAt: new Date(now),
      leaseExpiresAt: null,
      updatedAt: new Date(now)
    }).where(and(
      eq(deploymentCommands.id, commandId),
      inArray(deploymentCommands.state, ["pending", "claimed"])
    )).returning();
    if (command) return { command: toDeploymentCommand(command), applied: true };
    const authoritative = await this.findById(commandId);
    return authoritative ? { command: authoritative, applied: false } : null;
  }

  async findActiveForDeployment(deploymentId: string): Promise<DeploymentCommandRecord | null> {
    const [row] = await this.db
      .select()
      .from(deploymentCommands)
      .where(and(eq(deploymentCommands.deploymentId, deploymentId), inArray(deploymentCommands.state, [...ACTIVE_STATES])))
      .orderBy(desc(deploymentCommands.issuedAt))
      .limit(1);
    return row ? toDeploymentCommand(row) : null;
  }

  async list(): Promise<DeploymentCommandRecord[]> {
    const rows = await this.db.select().from(deploymentCommands).orderBy(asc(deploymentCommands.issuedAt));
    return rows.map(toDeploymentCommand);
  }
}

export const DB_DEPLOYMENT_COMMAND_KINDS: ReadonlyArray<DeploymentCommandKind> = ["start", "cancel", "restart", "rollback"];

export const DB_DEPLOYMENT_COMMAND_STATES: ReadonlyArray<DeploymentCommandState> = ["pending", "claimed", "executing", "completed", "cancelled", "failed"];

export const DB_DEPLOYMENT_COMMAND_TERMINAL_STATES: ReadonlyArray<DeploymentCommandState> = TERMINAL_STATES;

export const DB_DEPLOYMENT_COMMAND_ACTIVE_STATES: ReadonlyArray<DeploymentCommandState> = ACTIVE_STATES;

export function toDeploymentCommand(row: DeploymentCommandRow): DeploymentCommandRecord {
  return {
    id: row.id,
    deploymentId: row.deploymentId,
    agentId: row.agentId,
    kind: row.kind as DeploymentCommandKind,
    state: row.state as DeploymentCommandState,
    payload: (row.payload ?? {}) as Record<string, unknown>,
    requestedBy: row.requestedBy,
    requestId: row.requestId,
    correlationId: row.correlationId,
    issuedAt: row.issuedAt.toISOString(),
    claimedAt: row.claimedAt ? row.claimedAt.toISOString() : null,
    leaseExpiresAt: row.leaseExpiresAt ? row.leaseExpiresAt.toISOString() : null,
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
    failureReason: row.failureReason
  };
}

export function describeDeploymentCommandEventType(state: DeploymentCommandState): DeploymentCommandEventType {
  switch (state) {
    case "pending":
      return "deployment.command.submitted";
    case "claimed":
      return "deployment.command.claimed";
    case "executing":
      return "deployment.command.executing";
    case "completed":
      return "deployment.command.completed";
    case "failed":
      return "deployment.command.failed";
    case "cancelled":
      return "deployment.command.cancelled";
  }
}

export function assertDeploymentCommandSubmitInput(input: DeploymentCommandBusSubmitInput): void {
  if (!DB_DEPLOYMENT_COMMAND_KINDS.includes(input.kind)) {
    throw new Error(`Unsupported deployment command kind: ${input.kind}`);
  }
  if (typeof input.deploymentId !== "string" || input.deploymentId.length === 0) {
    throw new Error("deploymentId is required to submit a deployment command");
  }
  if (typeof input.agentId !== "string" || input.agentId.length === 0) {
    throw new Error("agentId is required to submit a deployment command");
  }
  if (typeof input.requestId !== "string" || input.requestId.length === 0) {
    throw new Error("requestId is required to submit a deployment command");
  }
  if (typeof input.correlationId !== "string" || input.correlationId.length === 0) {
    throw new Error("correlationId is required to submit a deployment command");
  }
}

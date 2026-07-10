import { and, asc, desc, eq, gt, inArray } from "drizzle-orm";
import type { DeploymentCommandKind, DeploymentCommandState } from "@deploylite/contracts";
import type {
  DeploymentCommandBusSubmitInput,
  DeploymentCommandEventType,
  DeploymentCommandRecord,
  DeploymentCommandRepository
} from "@deploylite/domain";

import type { DeployLiteDb } from "../client.js";
import { deploymentCommands, deployments, agents, type DeploymentCommandRow, type NewDeploymentCommandRow } from "../schema.js";

const TERMINAL_STATES: ReadonlyArray<DeploymentCommandState> = ["completed", "cancelled", "failed"];

const ACTIVE_STATES: ReadonlyArray<DeploymentCommandState> = ["pending", "claimed"];

export class DbDeploymentCommandRepository implements DeploymentCommandRepository {
  constructor(private readonly db: DeployLiteDb) {}

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
      eq(deploymentCommands.state, "claimed"),
      gt(deploymentCommands.leaseExpiresAt, new Date(now))
    )).returning();
    return row ? toDeploymentCommand(row) : null;
  }

  async transitionTerminal(
    commandId: string,
    agentId: string,
    expectedState: "pending" | "claimed",
    next: Pick<DeploymentCommandRecord, "state" | "completedAt" | "leaseExpiresAt" | "failureReason" | "payload">
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
      eq(deploymentCommands.state, expectedState)
    )).returning();
    if (row) return { command: toDeploymentCommand(row), applied: true };
    const authoritative = await this.findById(commandId);
    return authoritative?.agentId === agentId ? { command: authoritative, applied: false } : null;
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

export const DB_DEPLOYMENT_COMMAND_STATES: ReadonlyArray<DeploymentCommandState> = ["pending", "claimed", "completed", "cancelled", "failed"];

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

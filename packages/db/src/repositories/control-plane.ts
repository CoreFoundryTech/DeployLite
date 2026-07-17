import { and, eq, gt, isNull } from "drizzle-orm";
import type { ControlCommand, ControlCommandRepository, ControlConfirmation, ControlConfirmationRepository, ControlGrant, ControlGrantRepository, ConfirmationOutcome } from "@deploylite/domain";
import { IdempotencyConflictError, scopeKey } from "@deploylite/domain";

import type { DeployLiteDb } from "../client.js";
import { controlCommandAudits, controlCommandConfirmations, controlCommands, controlGrants, type ControlCommandRow, type ControlGrantRow } from "../schema.js";

export class DbControlGrantRepository implements ControlGrantRepository {
  constructor(private readonly db: DeployLiteDb) {}

  async listForActor(actorId: string): Promise<ControlGrant[]> {
    const rows = await this.db.select().from(controlGrants).where(eq(controlGrants.actorUserId, actorId));
    return rows.map(toGrant);
  }
}

export class DbControlCommandRepository implements ControlCommandRepository, ControlConfirmationRepository {
  constructor(private readonly db: DeployLiteDb) {}

  async resolve(command: ControlCommand): Promise<{ command: ControlCommand; created: boolean }> {
    const key = scopeKey(command.scope);
    const [created] = await this.db.insert(controlCommands).values({
      id: command.id, actorUserId: command.actorId, action: command.action, scopeKind: command.scope.kind, scopeKey: key,
      inputDigest: command.inputDigest, idempotencyKey: command.idempotencyKey, correlationId: command.correlationId,
      status: command.status, expiresAt: command.expiresAt
    }).onConflictDoNothing().returning();
    if (created) return { command: toCommand(created), created: true };

    const [existing] = await this.db.select().from(controlCommands).where(and(
      eq(controlCommands.actorUserId, command.actorId), eq(controlCommands.action, command.action),
      eq(controlCommands.scopeKey, key), eq(controlCommands.idempotencyKey, command.idempotencyKey)
    )).limit(1);
    if (!existing) throw new Error("Idempotency command was not found after conflict");
    if (existing.inputDigest !== command.inputDigest) throw new IdempotencyConflictError();
    return { command: toCommand(existing), created: false };
  }

  async bind(confirmation: ControlConfirmation): Promise<void> {
    await this.db.insert(controlCommandConfirmations).values({ id: confirmation.id, commandId: confirmation.commandId, actorUserId: confirmation.actorId, action: confirmation.action, scopeKind: confirmation.scope.kind, scopeKey: scopeKey(confirmation.scope), inputDigest: confirmation.inputDigest, classification: confirmation.classification, expiresAt: confirmation.expiresAt, consumedAt: confirmation.consumedAt });
  }

  async complete(command: ControlCommand): Promise<ControlCommand> {
    const [completed] = await this.db.update(controlCommands).set({ status: "completed", updatedAt: new Date() }).where(and(eq(controlCommands.id, command.id), eq(controlCommands.status, "eligible"))).returning();
    if (completed) return toCommand(completed);
    const [current] = await this.db.select().from(controlCommands).where(eq(controlCommands.id, command.id)).limit(1);
    if (!current) throw new Error("Control command was not found");
    return toCommand(current);
  }

  async consume(command: ControlCommand, confirmation: ControlConfirmation, now = new Date()): Promise<ConfirmationOutcome> {
    return this.db.transaction(async (tx) => {
      const [consumed] = await tx.update(controlCommandConfirmations).set({ consumedAt: now }).where(and(eq(controlCommandConfirmations.id, confirmation.id), eq(controlCommandConfirmations.commandId, command.id), eq(controlCommandConfirmations.actorUserId, command.actorId), eq(controlCommandConfirmations.action, command.action), eq(controlCommandConfirmations.scopeKind, command.scope.kind), eq(controlCommandConfirmations.scopeKey, scopeKey(command.scope)), eq(controlCommandConfirmations.inputDigest, command.inputDigest), eq(controlCommandConfirmations.classification, "destructive"), isNull(controlCommandConfirmations.consumedAt), gt(controlCommandConfirmations.expiresAt, now))).returning();
      if (!consumed) {
        const [storedConfirmation] = await tx.select({ id: controlCommandConfirmations.id }).from(controlCommandConfirmations).where(eq(controlCommandConfirmations.id, confirmation.id)).limit(1);
        await tx.insert(controlCommandAudits).values({ commandId: command.id, confirmationId: storedConfirmation?.id ?? null, correlationId: command.correlationId, outcome: "rejected", reason: "confirmation_rejected" });
        const [current] = await tx.select().from(controlCommands).where(eq(controlCommands.id, command.id)).limit(1);
        if (!current) throw new Error("Control command was not found");
        return { command: toCommand(current), accepted: false, reason: "confirmation_rejected" };
      }
      const [eligible] = await tx.update(controlCommands).set({ status: "eligible", updatedAt: now }).where(eq(controlCommands.id, command.id)).returning();
      await tx.insert(controlCommandAudits).values({ commandId: command.id, confirmationId: confirmation.id, correlationId: command.correlationId, outcome: "accepted", reason: null });
      if (!eligible) throw new Error("Control command was not found");
      return { command: toCommand(eligible), accepted: true, reason: null };
    });
  }
}

function toCommand(row: ControlCommandRow): ControlCommand {
  return { id: row.id, actorId: row.actorUserId, action: row.action as ControlCommand["action"], scope: row.scopeKind === "platform" ? { kind: "platform" } : { kind: "project", projectId: row.scopeKey }, inputDigest: row.inputDigest, idempotencyKey: row.idempotencyKey, correlationId: row.correlationId, status: row.status as ControlCommand["status"], expiresAt: row.expiresAt };
}

function toGrant(row: ControlGrantRow): ControlGrant {
  return { id: row.id, actorId: row.actorUserId, action: row.action as ControlGrant["action"], scope: row.scopeKind === "platform" ? { kind: "platform" } : { kind: "project", projectId: row.scopeKey } };
}

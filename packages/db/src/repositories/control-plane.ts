import { and, eq, gt, isNull } from "drizzle-orm";
import type { ConfirmedProjectDeleteInput, ConfirmedProjectDeleteOutcome, ControlCommand, ControlCommandRepository, ControlConfirmation, ControlConfirmationRepository, ConfirmationOutcome } from "@deploylite/domain";
import { IdempotencyConflictError, scopeKey } from "@deploylite/domain";

import type { DeployLiteDb } from "../client.js";
import { auditEvents, controlCommandAudits, controlCommandConfirmations, controlCommands, projects, type ControlCommandRow } from "../schema.js";

export type ControlDeleteFaultStage = "confirmation-consumed" | "project-deleted" | "command-completed" | "audit-recorded";
export class DbControlCommandRepository implements ControlCommandRepository, ControlConfirmationRepository {
  constructor(private readonly db: DeployLiteDb, private readonly injectFault?: (stage: ControlDeleteFaultStage) => void | Promise<void>) {}

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

  async executeConfirmedProjectDelete({ command, confirmation, projectId, requestId, now = new Date() }: ConfirmedProjectDeleteInput): Promise<ConfirmedProjectDeleteOutcome> {
    return this.db.transaction(async (tx) => {
      const [current] = await tx.select().from(controlCommands).where(eq(controlCommands.id, command.id)).limit(1);
      if (!current) throw new Error("Control command was not found");
      if (current.status === "completed") return { command: toCommand(current), accepted: true, reason: null, removed: true, auditRecorded: true, alreadyCompleted: true };
      const [consumed] = await tx.update(controlCommandConfirmations).set({ consumedAt: now }).where(and(eq(controlCommandConfirmations.id, confirmation.id), eq(controlCommandConfirmations.commandId, command.id), eq(controlCommandConfirmations.actorUserId, command.actorId), eq(controlCommandConfirmations.action, command.action), eq(controlCommandConfirmations.scopeKind, command.scope.kind), eq(controlCommandConfirmations.scopeKey, scopeKey(command.scope)), eq(controlCommandConfirmations.inputDigest, command.inputDigest), eq(controlCommandConfirmations.classification, "destructive"), isNull(controlCommandConfirmations.consumedAt), gt(controlCommandConfirmations.expiresAt, now))).returning();
      if (!consumed) {
        await tx.insert(controlCommandAudits).values({ commandId: command.id, confirmationId: confirmation.id, correlationId: command.correlationId, outcome: "rejected", reason: "confirmation_rejected" });
        return { command: toCommand(current), accepted: false, reason: "confirmation_rejected", removed: false, auditRecorded: true, alreadyCompleted: false };
      }
      await this.fault("confirmation-consumed");
      const [deleted] = await tx.delete(projects).where(eq(projects.id, projectId)).returning({ id: projects.id });
      if (!deleted) throw new Error("Project was not found for confirmed deletion");
      await this.fault("project-deleted");
      const [completed] = await tx.update(controlCommands).set({ status: "completed", updatedAt: now }).where(and(eq(controlCommands.id, command.id), eq(controlCommands.status, "pending_confirmation"))).returning();
      if (!completed) throw new Error("Control command was not eligible for completion");
      await this.fault("command-completed");
      await tx.insert(controlCommandAudits).values({ commandId: command.id, confirmationId: confirmation.id, correlationId: command.correlationId, outcome: "completed", reason: null });
      await tx.insert(auditEvents).values({ actorUserId: command.actorId, action: "project.delete", targetType: "project", targetId: projectId, requestId, correlationId: command.correlationId, metadata: { commandId: command.id, confirmationId: confirmation.id } });
      await this.fault("audit-recorded");
      return { command: toCommand(completed), accepted: true, reason: null, removed: true, auditRecorded: true, alreadyCompleted: false };
    });
  }

  private async fault(stage: ControlDeleteFaultStage): Promise<void> { await this.injectFault?.(stage); }
}

function toCommand(row: ControlCommandRow): ControlCommand {
  return { id: row.id, actorId: row.actorUserId, action: row.action as ControlCommand["action"], scope: row.scopeKind === "platform" ? { kind: "platform" } : { kind: "project", projectId: row.scopeKey }, inputDigest: row.inputDigest, idempotencyKey: row.idempotencyKey, correlationId: row.correlationId, status: row.status as ControlCommand["status"], expiresAt: row.expiresAt };
}

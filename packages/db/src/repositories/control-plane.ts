import { and, eq } from "drizzle-orm";
import type { ControlCommand, ControlCommandRepository } from "@deploylite/domain";
import { IdempotencyConflictError, scopeKey } from "@deploylite/domain";

import type { DeployLiteDb } from "../client.js";
import { controlCommands, type ControlCommandRow } from "../schema.js";

export class DbControlCommandRepository implements ControlCommandRepository {
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
}

function toCommand(row: ControlCommandRow): ControlCommand {
  return { id: row.id, actorId: row.actorUserId, action: row.action as ControlCommand["action"], scope: row.scopeKind === "platform" ? { kind: "platform" } : { kind: "project", projectId: row.scopeKey }, inputDigest: row.inputDigest, idempotencyKey: row.idempotencyKey, correlationId: row.correlationId, status: "pending", expiresAt: row.expiresAt };
}

import { createHash, randomUUID } from "node:crypto";
import type { CanonicalRole, ConfirmationClassification, ControlCommandStatus, ControlPlaneAction, ControlPlaneScope } from "@deploylite/contracts";

export type ControlGrant = { id: string; actorId: string; action: ControlPlaneAction; scope: ControlPlaneScope };
export type ControlGrantRepository = { listForActor(actorId: string): Promise<ControlGrant[]> };
export type PolicyRequest = { actorId: string; role: CanonicalRole; action: ControlPlaneAction; scope: ControlPlaneScope; correlationId: string; grants: ControlGrant[] };
export type PolicyDecision = { allowed: true; grantId: string; correlationId: string } | { allowed: false; code: "FORBIDDEN" | "ROLE_DENIED" | "SCOPE_DENIED"; correlationId: string };
export type ControlCommand = { id: string; actorId: string; action: ControlPlaneAction; scope: ControlPlaneScope; inputDigest: string; idempotencyKey: string; correlationId: string; status: ControlCommandStatus; expiresAt: Date };
export type ControlConfirmation = { id: string; commandId: string; actorId: string; action: ControlPlaneAction; scope: ControlPlaneScope; inputDigest: string; classification: ConfirmationClassification; expiresAt: Date; consumedAt: Date | null };
export type ConfirmationOutcome = { command: ControlCommand; accepted: boolean; reason: string | null };

const readOnlyRoles = new Set<CanonicalRole>(["read-only", "auditor"]);

export class PolicyEvaluator {
  evaluate(request: PolicyRequest): PolicyDecision {
    if (readOnlyRoles.has(request.role)) return { allowed: false, code: "ROLE_DENIED", correlationId: request.correlationId };
    const actionGrants = request.grants.filter((grant) => grant.actorId === request.actorId && grant.action === request.action);
    const grant = actionGrants.find((candidate) => grantApplies(candidate.scope, request.scope));
    if (grant) return { allowed: true, grantId: grant.id, correlationId: request.correlationId };
    return { allowed: false, code: actionGrants.length ? "SCOPE_DENIED" : "FORBIDDEN", correlationId: request.correlationId };
  }
}

export function digestControlInput(input: unknown): string {
  return createHash("sha256").update(stableJson(input)).digest("hex");
}

export function createControlCommand(input: Omit<ControlCommand, "id" | "inputDigest" | "status" | "expiresAt"> & { input: unknown; expiresAt?: Date }): ControlCommand {
  return { id: randomUUID(), actorId: input.actorId, action: input.action, scope: input.scope, inputDigest: digestControlInput(input.input), idempotencyKey: input.idempotencyKey, correlationId: input.correlationId, status: "pending_confirmation", expiresAt: input.expiresAt ?? new Date(Date.now() + 15 * 60_000) };
}

export function createConfirmation(input: { command: ControlCommand; classification: ConfirmationClassification; expiresAt?: Date }): ControlConfirmation {
  const { command } = input;
  return { id: randomUUID(), commandId: command.id, actorId: command.actorId, action: command.action, scope: command.scope, inputDigest: command.inputDigest, classification: input.classification, expiresAt: input.expiresAt ?? command.expiresAt, consumedAt: null };
}

export class ConfirmationRejectedError extends Error {
  readonly code = "CONFIRMATION_REJECTED";
  constructor() { super("Confirmation is not eligible for this command"); this.name = "ConfirmationRejectedError"; }
}

export function evaluateConfirmation(command: ControlCommand, confirmation: ControlConfirmation, now = new Date()): { eligible: true } {
  if (confirmation.commandId !== command.id || confirmation.actorId !== command.actorId || confirmation.action !== command.action || !scopesEqual(confirmation.scope, command.scope) || confirmation.inputDigest !== command.inputDigest || confirmation.classification !== "destructive" || confirmation.expiresAt <= now || confirmation.consumedAt !== null) throw new ConfirmationRejectedError();
  return { eligible: true };
}

export class IdempotencyConflictError extends Error {
  readonly code = "IDEMPOTENCY_CONFLICT";
  constructor() { super("Idempotency key was already used with different command input"); this.name = "IdempotencyConflictError"; }
}

export type ControlCommandRepository = {
  resolve(command: ControlCommand): Promise<{ command: ControlCommand; created: boolean }>;
  complete(command: ControlCommand): Promise<ControlCommand>;
};
export type ControlConfirmationRepository = {
  bind(confirmation: ControlConfirmation): Promise<void>;
  consume(command: ControlCommand, confirmation: ControlConfirmation, now?: Date): Promise<ConfirmationOutcome>;
};

export function scopeKey(scope: ControlPlaneScope): string { return scope.kind === "platform" ? "platform" : scope.projectId; }

function scopesEqual(left: ControlPlaneScope, right: ControlPlaneScope): boolean {
  return left.kind === right.kind && (left.kind === "platform" || left.projectId === (right as Extract<ControlPlaneScope, { kind: "project" }>).projectId);
}

function grantApplies(grantScope: ControlPlaneScope, requestedScope: ControlPlaneScope): boolean {
  return grantScope.kind === "platform" || scopesEqual(grantScope, requestedScope);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`).join(",")}}`;
  return JSON.stringify(value);
}

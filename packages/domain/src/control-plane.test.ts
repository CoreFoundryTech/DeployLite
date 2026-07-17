import { describe, expect, it } from "vitest";

import { ConfirmationRejectedError, IdempotencyConflictError, PolicyEvaluator, createConfirmation, createControlCommand, digestControlInput, evaluateConfirmation } from "./control-plane.js";

const evaluator = new PolicyEvaluator();
const request = { actorId: "actor-a", action: "project.delete" as const, scope: { kind: "project" as const, projectId: "project-a" }, correlationId: "corr-1" };

describe("control-plane policy", () => {
  it("denies absent, read-only, and auditor mutation grants", () => {
    expect(evaluator.evaluate({ ...request, role: "operator", grants: [] })).toMatchObject({ allowed: false, code: "FORBIDDEN", correlationId: "corr-1" });
    expect(evaluator.evaluate({ ...request, role: "read-only", grants: [{ id: "grant", actorId: request.actorId, action: "project.delete", scope: request.scope }] })).toMatchObject({ allowed: false, code: "ROLE_DENIED" });
    expect(evaluator.evaluate({ ...request, role: "auditor", grants: [{ id: "grant", actorId: request.actorId, action: "project.delete", scope: request.scope }] })).toMatchObject({ allowed: false, code: "ROLE_DENIED" });
  });

  it("requires admin for platform grants while preserving exact project grants for operators", () => {
    expect(evaluator.evaluate({ ...request, role: "operator", grants: [{ id: "other", actorId: request.actorId, action: "project.delete", scope: { kind: "project", projectId: "project-b" } }] })).toMatchObject({ allowed: false, code: "SCOPE_DENIED" });
    expect(evaluator.evaluate({ ...request, role: "operator", grants: [{ id: "platform", actorId: request.actorId, action: "project.delete", scope: { kind: "platform" } }] })).toMatchObject({ allowed: false, code: "SCOPE_DENIED" });
    expect(evaluator.evaluate({ ...request, scope: { kind: "platform" }, role: "operator", grants: [{ id: "platform", actorId: request.actorId, action: "project.delete", scope: { kind: "platform" } }] })).toMatchObject({ allowed: false, code: "SCOPE_DENIED" });
    expect(evaluator.evaluate({ ...request, role: "operator", grants: [{ id: "foreign", actorId: "actor-b", action: "project.delete", scope: request.scope }] })).toMatchObject({ allowed: false, code: "FORBIDDEN" });
    expect(evaluator.evaluate({ ...request, role: "operator", grants: [{ id: "exact", actorId: request.actorId, action: "project.delete", scope: request.scope }] })).toEqual({ allowed: true, grantId: "exact", correlationId: "corr-1" });
    expect(evaluator.evaluate({ ...request, role: "admin", grants: [{ id: "admin-platform", actorId: request.actorId, action: "project.delete", scope: { kind: "platform" } }] })).toEqual({ allowed: true, grantId: "admin-platform", correlationId: "corr-1" });
  });
});

describe("control command", () => {
  it("creates deterministic digests and correlated commands", () => {
    expect(digestControlInput({ b: 2, a: 1 })).toBe(digestControlInput({ a: 1, b: 2 }));
    expect(createControlCommand({ ...request, input: { a: 1 }, idempotencyKey: "same-key" })).toMatchObject({ inputDigest: digestControlInput({ a: 1 }), correlationId: "corr-1", status: "pending_confirmation" });
  });

  it("exposes a stable idempotency conflict code", () => {
    expect(new IdempotencyConflictError().code).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("rejects expired, consumed, and mismatched destructive confirmations", () => {
    const command = createControlCommand({ ...request, input: { projectId: "project-a" }, idempotencyKey: "confirmation-key" });
    const confirmation = createConfirmation({ command, classification: "destructive", expiresAt: new Date(Date.now() + 60_000) });

    expect(evaluateConfirmation(command, confirmation)).toEqual({ eligible: true });
    expect(() => evaluateConfirmation(command, { ...confirmation, actorId: "actor-b" })).toThrow(ConfirmationRejectedError);
    expect(() => evaluateConfirmation(command, { ...confirmation, inputDigest: digestControlInput({ projectId: "project-b" }) })).toThrow(ConfirmationRejectedError);
    expect(() => evaluateConfirmation(command, { ...confirmation, scope: { kind: "project", projectId: "project-b" } })).toThrow(ConfirmationRejectedError);
    expect(() => evaluateConfirmation(command, { ...confirmation, action: "project.deploy" })).toThrow(ConfirmationRejectedError);
    expect(() => evaluateConfirmation(command, { ...confirmation, classification: "non-destructive" })).toThrow(ConfirmationRejectedError);
    expect(() => evaluateConfirmation(command, { ...confirmation, expiresAt: new Date(0) })).toThrow(ConfirmationRejectedError);
    expect(() => evaluateConfirmation(command, { ...confirmation, consumedAt: new Date() })).toThrow(ConfirmationRejectedError);
  });
});

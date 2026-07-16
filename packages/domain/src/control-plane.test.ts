import { describe, expect, it } from "vitest";

import { IdempotencyConflictError, PolicyEvaluator, createControlCommand, digestControlInput } from "./control-plane.js";

const evaluator = new PolicyEvaluator();
const request = { actorId: "actor-a", action: "project.delete" as const, scope: { kind: "project" as const, projectId: "project-a" }, correlationId: "corr-1" };

describe("control-plane policy", () => {
  it("denies absent, read-only, and auditor mutation grants", () => {
    expect(evaluator.evaluate({ ...request, role: "operator", grants: [] })).toMatchObject({ allowed: false, code: "FORBIDDEN", correlationId: "corr-1" });
    expect(evaluator.evaluate({ ...request, role: "read-only", grants: [{ id: "grant", actorId: request.actorId, action: "project.delete", scope: request.scope }] })).toMatchObject({ allowed: false, code: "ROLE_DENIED" });
    expect(evaluator.evaluate({ ...request, role: "auditor", grants: [{ id: "grant", actorId: request.actorId, action: "project.delete", scope: request.scope }] })).toMatchObject({ allowed: false, code: "ROLE_DENIED" });
  });

  it("denies a cross-project grant and permits an exact project grant", () => {
    expect(evaluator.evaluate({ ...request, role: "operator", grants: [{ id: "other", actorId: request.actorId, action: "project.delete", scope: { kind: "project", projectId: "project-b" } }] })).toMatchObject({ allowed: false, code: "SCOPE_DENIED" });
    expect(evaluator.evaluate({ ...request, role: "operator", grants: [{ id: "foreign", actorId: "actor-b", action: "project.delete", scope: request.scope }] })).toMatchObject({ allowed: false, code: "FORBIDDEN" });
    expect(evaluator.evaluate({ ...request, role: "operator", grants: [{ id: "exact", actorId: request.actorId, action: "project.delete", scope: request.scope }] })).toEqual({ allowed: true, grantId: "exact", correlationId: "corr-1" });
  });
});

describe("control command", () => {
  it("creates deterministic digests and correlated commands", () => {
    expect(digestControlInput({ b: 2, a: 1 })).toBe(digestControlInput({ a: 1, b: 2 }));
    expect(createControlCommand({ ...request, input: { a: 1 }, idempotencyKey: "same-key" })).toMatchObject({ inputDigest: digestControlInput({ a: 1 }), correlationId: "corr-1", status: "pending" });
  });

  it("exposes a stable idempotency conflict code", () => {
    expect(new IdempotencyConflictError().code).toBe("IDEMPOTENCY_CONFLICT");
  });
});

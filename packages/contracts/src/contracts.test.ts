import { describe, expect, it } from "vitest";
import {
  agentHeartbeatSchema,
  agentSelfHeartbeatSchema,
  agentSelfRegistrationSchema,
  bootstrapInitialAdminRequestSchema,
  bootstrapStatusSchema,
  deploymentCommandEventTypeSchema,
  deploymentCommandKindSchema,
  deploymentCommandSchema,
  deploymentCommandStateSchema,
  envSecretValueDeleteRequestSchema,
  envSecretValueSchema,
  envSecretValueWriteRequestSchema,
  logEventSchema,
  projectCreateRequestSchema,
  projectSchema,
  projectUpdateRequestSchema,
  sseEventSchema
} from "./index.js";

const now = new Date().toISOString();

describe("contracts", () => {
  it("rejects invalid heartbeat resource snapshots", () => {
    const result = agentHeartbeatSchema.safeParse({
      agentId: "agent_1",
      observedAt: now,
      requestId: "req_1",
      correlationId: "req_1",
      resourceSnapshot: {
        cpuLoad: 1.5,
        memoryUsedBytes: 10,
        memoryTotalBytes: 0,
        diskUsedBytes: 10,
        diskTotalBytes: 20
      }
    });

    expect(result.success).toBe(false);
  });

  it("keeps agent self-registration and heartbeat identity explicit and strict", () => {
    const resourceSnapshot = { cpuLoad: 0.2, memoryUsedBytes: 10, memoryTotalBytes: 20, diskUsedBytes: 30, diskTotalBytes: 40 };
    expect(agentSelfRegistrationSchema.parse({ agentId: "agent_1", name: "Agent", endpoint: "http://agent.test", observedAt: now, resourceSnapshot })).toMatchObject({ agentId: "agent_1" });
    expect(agentSelfHeartbeatSchema.safeParse({ agentId: "agent_1", observedAt: now, resourceSnapshot, token: "forbidden" }).success).toBe(false);
  });

  it("requires log events to carry request context and redaction state", () => {
    const result = logEventSchema.safeParse({
      id: "log_1",
      deploymentId: "dep_1",
      sequence: 1,
      level: "info",
      message: "Deployment started",
      timestamp: now,
      redactionApplied: true,
      requestId: "req_1",
      correlationId: "req_1"
    });

    expect(result.success).toBe(true);
  });

  it("rejects non-monotonic SSE event identifiers", () => {
    expect(sseEventSchema.safeParse({ id: -1, event: "deployment.log", data: {} }).success).toBe(false);
  });

  it("parses bootstrap status without exposing user details", () => {
    const result = bootstrapStatusSchema.parse({ setupRequired: true });

    expect(result).toEqual({ setupRequired: true });
  });

  it("validates initial admin bootstrap payloads", () => {
    expect(bootstrapInitialAdminRequestSchema.safeParse({ email: "admin@example.test", password: "long-enough-password" }).success).toBe(true);
    expect(bootstrapInitialAdminRequestSchema.safeParse({ email: "not-email", password: "short" }).success).toBe(false);
  });

  it("accepts nullable runtime clears in project update payloads", () => {
    const result = projectUpdateRequestSchema.parse({
      name: "DeployLite API",
      buildCommand: null,
      runCommand: null,
      port: null
    });

    expect(result).toEqual({ name: "DeployLite API", buildCommand: null, runCommand: null, port: null });
  });

  it("rejects empty required project update fields and invalid ports", () => {
    expect(projectUpdateRequestSchema.safeParse({ name: "" }).success).toBe(false);
    expect(projectUpdateRequestSchema.safeParse({ repoUrl: "not-a-url" }).success).toBe(false);
    expect(projectUpdateRequestSchema.safeParse({ defaultBranch: "" }).success).toBe(false);
    expect(projectUpdateRequestSchema.safeParse({ port: 0 }).success).toBe(false);
    expect(projectUpdateRequestSchema.safeParse({ port: 65536 }).success).toBe(false);
  });

  it("accepts a project create payload with an optional description", () => {
    const result = projectCreateRequestSchema.parse({
      name: "Demo",
      repoUrl: "https://github.com/example/demo",
      defaultBranch: "main",
      description: "Internal admin app for staging"
    });

    expect(result).toEqual({
      name: "Demo",
      repoUrl: "https://github.com/example/demo",
      defaultBranch: "main",
      description: "Internal admin app for staging"
    });
  });

  it("treats project description as nullable on the canonical project schema", () => {
    const parsed = projectSchema.parse({
      id: "project_1",
      name: "Demo",
      repoUrl: "https://github.com/example/demo",
      defaultBranch: "main",
      buildCommand: null,
      runCommand: null,
      port: null,
      description: null,
      imageTag: null
    });

    expect(parsed.description).toBeNull();
  });

  it("clears project description via a project update payload", () => {
    const result = projectUpdateRequestSchema.parse({ description: null });

    expect(result).toEqual({ description: null });
  });

  it("accepts a project image tag on create, surfaces it on the canonical schema, and clears via null on update", () => {
    const created = projectCreateRequestSchema.parse({
      name: "Tagged",
      repoUrl: "https://github.com/example/tagged",
      defaultBranch: "main",
      imageTag: "ghcr.io/example/tagged:v1.2.3"
    });

    expect(created.imageTag).toBe("ghcr.io/example/tagged:v1.2.3");

    const canonical = projectSchema.parse({
      id: "project_tagged",
      name: "Tagged",
      repoUrl: "https://github.com/example/tagged",
      defaultBranch: "main",
      buildCommand: null,
      runCommand: null,
      port: null,
      description: null,
      imageTag: "v1.0.0"
    });

    expect(canonical.imageTag).toBe("v1.0.0");

    const cleared = projectUpdateRequestSchema.parse({ imageTag: null });
    expect(cleared).toEqual({ imageTag: null });
  });

  it("rejects empty or oversized project image tags across create and update payloads", () => {
    expect(projectCreateRequestSchema.safeParse({
      name: "Tagged",
      repoUrl: "https://github.com/example/tagged",
      defaultBranch: "main",
      imageTag: ""
    }).success).toBe(false);

    expect(projectUpdateRequestSchema.safeParse({ imageTag: "" }).success).toBe(false);
    expect(projectUpdateRequestSchema.safeParse({ imageTag: "x".repeat(257) }).success).toBe(false);
  });

  it("accepts an env secret value write payload with a non-empty value", () => {
    const parsed = envSecretValueWriteRequestSchema.parse({
      key: "DATABASE_URL",
      scope: "project",
      value: "postgres://user:pass@db:5432/app"
    });
    expect(parsed).toEqual({
      key: "DATABASE_URL",
      scope: "project",
      value: "postgres://user:pass@db:5432/app"
    });
  });

  it("rejects env secret value write payloads with empty values or unknown scopes", () => {
    expect(envSecretValueWriteRequestSchema.safeParse({ key: "DATABASE_URL", value: "" }).success).toBe(false);
    expect(envSecretValueWriteRequestSchema.safeParse({ key: "DATABASE_URL", value: "v", scope: "runtime" as never }).success).toBe(false);
    expect(envSecretValueWriteRequestSchema.safeParse({ key: "", value: "v" }).success).toBe(false);
  });

  it("rejects env secret value write payloads that smuggle extra fields (strict mode)", () => {
    expect(
      envSecretValueWriteRequestSchema.safeParse({
        key: "DATABASE_URL",
        value: "v",
        encryptedValue: "should-not-be-accepted-here"
      }).success
    ).toBe(false);
  });

  it("serializes the canonical env secret value schema without exposing any encrypted or raw value field", () => {
    const parsed = envSecretValueSchema.parse({
      id: "envv_1",
      projectId: "project_1",
      key: "DATABASE_URL",
      scope: "project",
      valuePresent: true,
      valueFingerprint: "abcdef0123456789abcdef0123456789",
      keyVersion: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    });

    expect(Object.keys(parsed)).not.toContain("encryptedValue");
    expect(Object.keys(parsed)).not.toContain("value");
    expect(Object.keys(parsed)).not.toContain("plaintextValue");
    expect(parsed.valueFingerprint).toBe("abcdef0123456789abcdef0123456789");
  });

  it("accepts env secret value delete payloads with a default scope of project", () => {
    const parsed = envSecretValueDeleteRequestSchema.parse({ key: "DATABASE_URL" });
    expect(parsed).toEqual({ key: "DATABASE_URL", scope: "project" });
    const explicit = envSecretValueDeleteRequestSchema.parse({ key: "DATABASE_URL", scope: "deployment" });
    expect(explicit.scope).toBe("deployment");
  });

  it("exposes the deployment command bus state and kind enums and rejects unknown values", () => {
    expect(deploymentCommandStateSchema.options).toEqual(["pending", "claimed", "completed", "cancelled", "failed"]);
    expect(deploymentCommandKindSchema.options).toEqual(["start", "cancel", "restart", "rollback"]);

    expect(deploymentCommandStateSchema.safeParse("queued").success).toBe(false);
    expect(deploymentCommandKindSchema.safeParse("teardown").success).toBe(false);
  });

  it("parses a well-formed deployment command and rejects commands missing request context", () => {
    const now = "2026-01-01T00:00:00.000Z";
    const parsed = deploymentCommandSchema.parse({
      id: "cmd_1",
      deploymentId: "dep_1",
      agentId: "agent_1",
      kind: "start",
      state: "pending",
      payload: { commitSha: "abcdef1" },
      requestedBy: null,
      requestId: "req_1",
      correlationId: "corr_1",
      issuedAt: now,
      claimedAt: null,
      completedAt: null,
      failureReason: null
    });

    expect(parsed.state).toBe("pending");
    expect(parsed.payload).toEqual({ commitSha: "abcdef1" });

    const missingContext = deploymentCommandSchema.safeParse({
      id: "cmd_2",
      deploymentId: "dep_1",
      agentId: "agent_1",
      kind: "start",
      state: "pending",
      payload: {},
      requestedBy: null,
      issuedAt: now,
      claimedAt: null,
      completedAt: null,
      failureReason: null
    });
    expect(missingContext.success).toBe(false);
  });

  it("exposes the deployment command bus event type enum covering the lifecycle transitions", () => {
    expect(deploymentCommandEventTypeSchema.options).toEqual([
      "deployment.command.submitted",
      "deployment.command.claimed",
      "deployment.command.completed",
      "deployment.command.failed",
      "deployment.command.cancelled"
    ]);
    expect(deploymentCommandEventTypeSchema.safeParse("deployment.command.unknown").success).toBe(false);
  });
});

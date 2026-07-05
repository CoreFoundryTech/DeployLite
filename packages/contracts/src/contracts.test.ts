import { describe, expect, it } from "vitest";
import { agentHeartbeatSchema, bootstrapInitialAdminRequestSchema, bootstrapStatusSchema, logEventSchema, projectCreateRequestSchema, projectSchema, projectUpdateRequestSchema, sseEventSchema } from "./index.js";

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
      description: null
    });

    expect(parsed.description).toBeNull();
  });

  it("clears project description via a project update payload", () => {
    const result = projectUpdateRequestSchema.parse({ description: null });

    expect(result).toEqual({ description: null });
  });
});

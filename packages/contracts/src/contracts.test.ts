import { describe, expect, it } from "vitest";
import { agentHeartbeatSchema, logEventSchema, sseEventSchema } from "./index.js";

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
});

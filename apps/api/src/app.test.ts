import { describe, expect, it } from "vitest";
import { AUTH_HEADER, buildApiApp } from "./app.js";

const authHeaders = { [AUTH_HEADER]: "scaffold-dev", "content-type": "application/json" };

describe("DeployLite API scaffold", () => {
  it("generates request IDs and returns health in the standard envelope", async () => {
    const app = await buildApiApp();
    const response = await app.inject({ method: "GET", url: "/api/v1/health" });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(response.headers["x-request-id"]).toBeTypeOf("string");
    expect(body.requestId).toBe(response.headers["x-request-id"]);
    expect(body.error).toBeNull();
    expect(body.data.status).toBe("ok");
  });

  it("returns a safe scaffold auth error envelope for protected routes", async () => {
    const app = await buildApiApp();
    const response = await app.inject({ method: "GET", url: "/api/v1/auth/me", headers: { "x-request-id": "req_test_1" } });
    const body = response.json();

    expect(response.statusCode).toBe(401);
    expect(body.requestId).toBe("req_test_1");
    expect(body.error).toEqual({ code: "UNAUTHENTICATED", message: "Scaffold-only auth required; this is not production authentication.", correlationId: "req_test_1" });
  });

  it("records heartbeat status with audit correlation metadata", async () => {
    const app = await buildApiApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/agents/agent_mock_1/heartbeat",
      headers: { ...authHeaders, "x-request-id": "req_heartbeat_1" },
      payload: {
        observedAt: "2026-01-01T00:01:00.000Z",
        resourceSnapshot: { cpuLoad: 0.5, memoryUsedBytes: 1024, memoryTotalBytes: 2048, diskUsedBytes: 20_000, diskTotalBytes: 100_000 }
      }
    });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body.data.agent.status).toBe("online");
    expect(body.data.audit).toMatchObject({ action: "agent.heartbeat", requestId: "req_heartbeat_1", correlationId: "req_heartbeat_1" });
  });

  it("resumes SSE deployment logs after Last-Event-ID and keeps output redacted", async () => {
    const app = await buildApiApp();
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/deployments/dep_mock_1/logs/stream",
      headers: { ...authHeaders, "last-event-id": "1", "x-request-id": "req_logs_1" }
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    expect(response.body).not.toContain("id: 1");
    expect(response.body).toContain("id: 2");
    expect(response.body).toContain("[REDACTED]");
    expect(response.body).not.toContain("dl_1234567890abcdef");
    expect(response.body).toContain("req_logs_1");
  });

  it("rejects unsafe heartbeat payloads without leaking validation details", async () => {
    const app = await buildApiApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/agents/agent_mock_1/heartbeat",
      headers: { ...authHeaders, "x-request-id": "req_invalid_1" },
      payload: {
        observedAt: "2026-01-01T00:01:00.000Z",
        resourceSnapshot: { cpuLoad: 5, memoryUsedBytes: 1024, memoryTotalBytes: 0, diskUsedBytes: 20_000, diskTotalBytes: 100_000 }
      }
    });
    const body = response.json();

    expect(response.statusCode).toBe(400);
    expect(body.error).toEqual({ code: "VALIDATION_ERROR", message: "Request validation failed.", correlationId: "req_invalid_1" });
    expect(JSON.stringify(body)).not.toContain("dl_");
  });
});

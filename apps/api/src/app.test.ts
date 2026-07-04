import { BcryptPasswordHasher, createOpaqueSessionToken, hashSessionToken } from "@deploylite/db";
import type { AuthUser } from "@deploylite/domain";
import { describe, expect, it } from "vitest";
import { buildApiApp, InMemoryAuditRepository, InMemoryAuthUserRepository, InMemorySessionRepository } from "./app.js";

const contentHeaders = { "content-type": "application/json" };
const password = "correct horse battery staple";

async function authFixture(overrides: Partial<AuthUser> = {}) {
  const hasher = new BcryptPasswordHasher(10);
  const now = new Date("2026-01-01T00:00:00.000Z");
  const user: AuthUser = {
    id: "user_test_1",
    email: "admin@example.test",
    emailNormalized: "admin@example.test",
    passwordHash: await hasher.hash(password),
    role: "admin",
    status: "active",
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
  const audit = new InMemoryAuditRepository();
  const sessions = new InMemorySessionRepository();
  const users = new InMemoryAuthUserRepository([user]);
  const app = await buildApiApp({ auth: { audit, hasher, sessions, users }, authConfig: { cookieName: "dl_test_session", cookieSecure: false, sessionTtlSeconds: 3600 } });
  return { app, audit, sessions, user };
}

async function loginCookie(app: Awaited<ReturnType<typeof buildApiApp>>, email = "admin@example.test") {
  const response = await app.inject({ method: "POST", url: "/api/v1/auth/login", headers: contentHeaders, payload: { email, password } });
  return response.headers["set-cookie"] as string;
}

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

  it("returns a safe auth error envelope for protected routes", async () => {
    const { app } = await authFixture();
    const response = await app.inject({ method: "GET", url: "/api/v1/auth/me", headers: { "x-request-id": "req_test_1" } });
    const body = response.json();

    expect(response.statusCode).toBe(401);
    expect(body.requestId).toBe("req_test_1");
    expect(body.error).toEqual({ code: "UNAUTHENTICATED", message: "Authentication required.", correlationId: "req_test_1" });
  });

  it("logs in with an opaque HttpOnly cookie and returns API-safe identity", async () => {
    const { app } = await authFixture();
    const response = await app.inject({ method: "POST", url: "/api/v1/auth/login", headers: { ...contentHeaders, "x-request-id": "req_login_1" }, payload: { email: "admin@example.test", password } });
    const body = response.json();
    const cookie = response.headers["set-cookie"] as string;

    expect(response.statusCode).toBe(200);
    expect(cookie).toContain("dl_test_session=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).not.toContain("Secure");
    expect(body.data.user).toEqual({ id: "user_test_1", email: "admin@example.test", role: "admin", status: "active" });
    expect(JSON.stringify(body)).not.toContain("passwordHash");
  });

  it("uses the secure cookie flag when configured", async () => {
    const hasher = new BcryptPasswordHasher(10);
    const user = { id: "user_secure_1", email: "admin@example.test", emailNormalized: "admin@example.test", passwordHash: await hasher.hash(password), role: "admin" as const, status: "active" as const, createdAt: new Date(), updatedAt: new Date() };
    const app = await buildApiApp({ auth: { hasher, users: new InMemoryAuthUserRepository([user]) }, authConfig: { cookieName: "secure_session", cookieSecure: true, sessionTtlSeconds: 3600 } });
    const response = await app.inject({ method: "POST", url: "/api/v1/auth/login", headers: contentHeaders, payload: { email: "admin@example.test", password } });

    expect(response.headers["set-cookie"]).toContain("Secure");
  });

  it("resolves /auth/me from the session cookie and logout revokes it", async () => {
    const { app } = await authFixture();
    const cookie = await loginCookie(app);

    const me = await app.inject({ method: "GET", url: "/api/v1/auth/me", headers: { cookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json().data.user.role).toBe("admin");

    const logout = await app.inject({ method: "POST", url: "/api/v1/auth/logout", headers: { cookie } });
    expect(logout.statusCode).toBe(200);
    expect(logout.headers["set-cookie"]).toContain("Max-Age=0");

    const afterLogout = await app.inject({ method: "GET", url: "/api/v1/auth/me", headers: { cookie } });
    expect(afterLogout.statusCode).toBe(401);
  });

  it("rejects disabled users and records a redacted failed-login audit event", async () => {
    const { app, audit } = await authFixture({ status: "disabled" });
    const response = await app.inject({ method: "POST", url: "/api/v1/auth/login", headers: contentHeaders, payload: { email: "admin@example.test", password } });

    expect(response.statusCode).toBe(401);
    expect(audit.inputs).toHaveLength(1);
    expect(audit.inputs[0]?.action).toBe("auth.login.failed");
    expect(JSON.stringify(audit.inputs[0]?.metadata)).not.toContain(password);
    expect(JSON.stringify(audit.inputs[0]?.metadata)).toContain("[REDACTED]");
  });

  it("rejects expired sessions", async () => {
    const { app, sessions, user } = await authFixture();
    const token = createOpaqueSessionToken(1, new Date("2026-01-01T00:00:00.000Z"));
    await sessions.create({ userId: user.id, tokenHash: token.tokenHash, expiresAt: new Date("2020-01-01T00:00:00.000Z") });

    const response = await app.inject({ method: "GET", url: "/api/v1/auth/me", headers: { cookie: `dl_test_session=${token.token}` } });
    expect(response.statusCode).toBe(401);
  });

  it("rejects revoked sessions", async () => {
    const { app, sessions, user } = await authFixture();
    const token = createOpaqueSessionToken(3600);
    const session = await sessions.create({ userId: user.id, tokenHash: hashSessionToken(token.token), expiresAt: token.expiresAt });
    await sessions.revoke(session.id);

    const response = await app.inject({ method: "GET", url: "/api/v1/auth/me", headers: { cookie: `dl_test_session=${token.token}` } });
    expect(response.statusCode).toBe(401);
  });

  it("denies read-only protected mutations and records audit metadata", async () => {
    const { app, audit } = await authFixture({ role: "read-only" });
    const cookie = await loginCookie(app);
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers: { ...contentHeaders, cookie, "x-request-id": "req_forbidden_1" },
      payload: { name: "Denied", repoUrl: "https://github.com/CoreFoundryTech/DeployLite", defaultBranch: "main" }
    });

    expect(response.statusCode).toBe(403);
    expect(audit.inputs.some((event) => event.action === "protected.denied" && event.requestId === "req_forbidden_1" && event.metadata?.["reason"] === "insufficient-role")).toBe(true);
  });

  it("records heartbeat status with audit correlation metadata", async () => {
    const { app } = await authFixture();
    const cookie = await loginCookie(app);
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/agents/agent_mock_1/heartbeat",
      headers: { ...contentHeaders, cookie, "x-request-id": "req_heartbeat_1" },
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
    const { app } = await authFixture();
    const cookie = await loginCookie(app);
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/deployments/dep_mock_1/logs/stream",
      headers: { cookie, "last-event-id": "1", "x-request-id": "req_logs_1" }
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
    const { app } = await authFixture();
    const cookie = await loginCookie(app);
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/agents/agent_mock_1/heartbeat",
      headers: { ...contentHeaders, cookie, "x-request-id": "req_invalid_1" },
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

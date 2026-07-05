import { BcryptPasswordHasher, createOpaqueSessionToken, hashSessionToken } from "@deploylite/db";
import {
  InitialAdminAlreadyExistsError,
  InMemoryEnvVariableMetadataRepository,
  type AgentRepository,
  type AuthUser,
  type AuthUserRepository,
  type CreateInitialAdminInput,
  type DeploymentRepository,
  type EnvVariableMetadataRecord,
  type EnvVariableMetadataRepository,
  type ProjectRepository
} from "@deploylite/domain";
import { describe, expect, it } from "vitest";
import { buildApiApp, createRuntimeRepositories, InMemoryAuditRepository, InMemoryAuthUserRepository, InMemorySessionRepository } from "./app.js";

const contentHeaders = { "content-type": "application/json" };
const password = "correct horse battery staple";

function projectFixture(id = "project-1") {
  return {
    id,
    name: "DeployLite",
    repoUrl: "https://github.com/CoreFoundryTech/DeployLite",
    defaultBranch: "main",
    buildCommand: "pnpm build",
    runCommand: "pnpm start",
    port: 3000,
    description: null
  };
}

type AuthFixtureOptions = {
  dbMode?: boolean;
  state?: NonNullable<Parameters<typeof buildApiApp>[0]>["state"];
  user?: Partial<AuthUser>;
};

async function authFixture(options: AuthFixtureOptions = {}) {
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
    ...options.user
  };
  const audit = new InMemoryAuditRepository();
  const sessions = new InMemorySessionRepository();
  const users = new InMemoryAuthUserRepository([user]);
  const app = await buildApiApp({
    auth: { audit, hasher, sessions, users },
    authConfig: { cookieName: "dl_test_session", cookieSecure: false, sessionTtlSeconds: 3600 },
    db: options.dbMode ? { pool: {} as never, client: {} as never } : undefined,
    env: options.dbMode ? { ...process.env, NODE_ENV: "test", DATABASE_URL: "postgres://user:pass@localhost:5432/deploylite" } : undefined,
    state: options.state
  });
  return { app, audit, sessions, user };
}

function metadataRepositories() {
  const calls: string[] = [];
  const projects: ProjectRepository = {
    async save() {
      calls.push("projects.save");
      throw new Error("metadata read routes must not create projects");
    },
    async findById(id) {
      calls.push("projects.findById");
      return id === "project-1" ? projectFixture(id) : null;
    },
    async list() {
      calls.push("projects.list");
      return [projectFixture()];
    },
    async remove() {
      calls.push("projects.remove");
      return false;
    }
  };
  const agents: AgentRepository = {
    async save() {
      calls.push("agents.save");
      throw new Error("metadata read routes must not register agents");
    },
    async findById(id) {
      calls.push("agents.findById");
      return id === "agent-1" ? { id, name: "Local agent", endpoint: "https://agent.example.test", status: "online", lastHeartbeatAt: null, resourceSnapshot: null } : null;
    },
    async list() {
      calls.push("agents.list");
      return [{ id: "agent-1", name: "Local agent", endpoint: "https://agent.example.test", status: "online", lastHeartbeatAt: null, resourceSnapshot: null }];
    }
  };
  const deployments: DeploymentRepository = {
    async save() {
      calls.push("deployments.save");
      throw new Error("metadata read routes must not create deployments");
    },
    async findById(id) {
      calls.push("deployments.findById");
      return id === "dep-1" ? { id, projectId: "project-1", agentId: "agent-1", status: "running", commitSha: "abcdef1", startedAt: "2026-01-01T00:00:00.000Z", finishedAt: null } : null;
    },
    async list() {
      calls.push("deployments.list");
      return [{ id: "dep-1", projectId: "project-1", agentId: "agent-1", status: "running", commitSha: "abcdef1", startedAt: "2026-01-01T00:00:00.000Z", finishedAt: null }];
    },
    async appendLog() {
      calls.push("deployments.appendLog");
      throw new Error("metadata read routes must not append logs");
    },
    async listLogs(deploymentId) {
      calls.push("deployments.listLogs");
      return deploymentId === "dep-1" ? [{ id: "log-1", deploymentId, sequence: 1, level: "info", message: "Started", timestamp: "2026-01-01T00:00:00.000Z", redactionApplied: true, requestId: "req-1", correlationId: "req-1" }] : [];
    }
  };

  return { calls, state: { agents, deployments, projects, envMetadata: new InMemoryEnvVariableMetadataRepository() } };
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

  it("allows local web dev credentialed browser requests", async () => {
    const app = await buildApiApp({ corsOrigin: "http://localhost:3000" });
    const response = await app.inject({
      method: "OPTIONS",
      url: "/api/v1/auth/login",
      headers: { origin: "http://localhost:3000", "access-control-request-method": "POST" }
    });

    expect(response.statusCode).toBe(204);
    expect(response.headers["access-control-allow-origin"]).toBe("http://localhost:3000");
    expect(response.headers["access-control-allow-credentials"]).toBe("true");
  });

  it("uses the configured production CORS origin only for matching credentialed requests", async () => {
    const app = await buildApiApp({
      env: {
        ...process.env,
        NODE_ENV: "production",
        DEPLOYLITE_CORS_ORIGIN: "http://deploylite.example.test",
        DEPLOYLITE_SESSION_COOKIE_SECURE: "false"
      }
    });

    const allowed = await app.inject({
      method: "OPTIONS",
      url: "/api/v1/auth/login",
      headers: { origin: "http://deploylite.example.test", "access-control-request-method": "POST" }
    });
    const rejected = await app.inject({
      method: "OPTIONS",
      url: "/api/v1/auth/login",
      headers: { origin: "http://evil.example.test", "access-control-request-method": "POST" }
    });

    expect(allowed.statusCode).toBe(204);
    expect(allowed.headers["access-control-allow-origin"]).toBe("http://deploylite.example.test");
    expect(allowed.headers["access-control-allow-credentials"]).toBe("true");
    expect(rejected.statusCode).toBe(204);
    expect(rejected.headers["access-control-allow-origin"]).toBeUndefined();
    expect(rejected.headers["access-control-allow-credentials"]).toBeUndefined();
  });

  it("selects DB auth repositories when DATABASE_URL is configured", async () => {
    const repositories = await createRuntimeRepositories(
      { NODE_ENV: "test", DEPLOYLITE_API_URL: "http://localhost:3001", DEPLOYLITE_API_HOST: "127.0.0.1", DEPLOYLITE_API_PORT: 3001, DATABASE_URL: "postgres://user:pass@localhost:5432/deploylite", DEPLOYLITE_SESSION_TTL_SECONDS: 3600, DEPLOYLITE_SESSION_COOKIE_NAME: "dl_test_session", DEPLOYLITE_BCRYPT_COST: 10 },
      { db: { pool: {} as never, client: {} as never } }
    );

    expect(repositories.auth.users.constructor.name).toBe("DbAuthUserRepository");
    expect(repositories.shouldSeedMockData).toBe(false);
  });

  it("closes owned DB pools when the app closes", async () => {
    let closed = false;
    const app = await buildApiApp({
      env: { ...process.env, NODE_ENV: "test", DATABASE_URL: "postgres://user:pass@localhost:5432/deploylite" },
      db: {
        createPool: () => ({}) as never,
        client: {} as never,
        closePool: async () => {
          closed = true;
        }
      }
    });

    await app.close();

    expect(closed).toBe(true);
  });

  it("does not seed mock auth or mock data in DB mode", async () => {
    const audit = new InMemoryAuditRepository();
    const users = new InMemoryAuthUserRepository();
    const app = await buildApiApp({
      auth: { audit, users, sessions: new InMemorySessionRepository(), hasher: new BcryptPasswordHasher(10) },
      env: { ...process.env, NODE_ENV: "test", DATABASE_URL: "postgres://user:pass@localhost:5432/deploylite" },
      db: { pool: {} as never, client: {} as never }
    });

    const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", headers: contentHeaders, payload: { email: "admin@example.test", password: "deploylite-admin-password" } });
    const projects = await app.inject({ method: "GET", url: "/api/v1/projects" });

    expect(login.statusCode).toBe(401);
    expect(projects.statusCode).toBe(401);
  });

  it("reports bootstrap status from user count", async () => {
    const app = await buildApiApp({ auth: { users: new InMemoryAuthUserRepository() } });
    const response = await app.inject({ method: "GET", url: "/api/v1/bootstrap/status" });

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual({ setupRequired: true });
  });

  it("reports bootstrap status as not required after the first user is created", async () => {
    const users = new InMemoryAuthUserRepository();
    const app = await buildApiApp({ auth: { users } });

    const before = await app.inject({ method: "GET", url: "/api/v1/bootstrap/status" });
    expect(before.statusCode).toBe(200);
    expect(before.json().data).toEqual({ setupRequired: true });

    const created = await app.inject({ method: "POST", url: "/api/v1/bootstrap/initial-admin", headers: contentHeaders, payload: { email: "first@example.test", password: "long-enough-password" } });
    expect(created.statusCode).toBe(200);

    const after = await app.inject({ method: "GET", url: "/api/v1/bootstrap/status" });
    expect(after.statusCode).toBe(200);
    expect(after.json().data).toEqual({ setupRequired: false });

    await app.close();
  });

  it("creates the first admin and records an audit event", async () => {
    const audit = new InMemoryAuditRepository();
    const app = await buildApiApp({ auth: { audit, users: new InMemoryAuthUserRepository() } });
    const response = await app.inject({ method: "POST", url: "/api/v1/bootstrap/initial-admin", headers: { ...contentHeaders, "x-request-id": "req_bootstrap_1" }, payload: { email: "first@example.test", password: "long-enough-password" } });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.user).toEqual(expect.objectContaining({ email: "first@example.test", role: "admin", status: "active" }));
    expect(audit.inputs.some((event) => event.action === "bootstrap.initial-admin" && event.requestId === "req_bootstrap_1")).toBe(true);
  });

  it("records the first-owner bootstrap audit with an anonymous actor", async () => {
    const audit = new InMemoryAuditRepository();
    const app = await buildApiApp({ auth: { audit, users: new InMemoryAuthUserRepository() } });
    const response = await app.inject({ method: "POST", url: "/api/v1/bootstrap/initial-admin", headers: { ...contentHeaders, "x-request-id": "req_bootstrap_anon_1" }, payload: { email: "first@example.test", password: "long-enough-password" } });

    expect(response.statusCode).toBe(200);
    const created = audit.events.find((event) => event.action === "bootstrap.initial-admin" && event.requestId === "req_bootstrap_anon_1");
    expect(created).toBeDefined();
    expect(created?.actorId).toBe("anonymous");

    await app.close();
  });

  it("rejects invalid bootstrap input and audits the rejection", async () => {
    const audit = new InMemoryAuditRepository();
    const app = await buildApiApp({ auth: { audit, users: new InMemoryAuthUserRepository() } });
    const response = await app.inject({ method: "POST", url: "/api/v1/bootstrap/initial-admin", headers: contentHeaders, payload: { email: "bad", password: "short" } });

    expect(response.statusCode).toBe(400);
    expect(audit.inputs.some((event) => event.action === "bootstrap.initial-admin.rejected" && event.metadata?.["reason"] === "invalid-input")).toBe(true);
  });

  it("rejects bootstrap after setup is locked and audits the rejection", async () => {
    const { app, audit } = await authFixture();
    const response = await app.inject({ method: "POST", url: "/api/v1/bootstrap/initial-admin", headers: contentHeaders, payload: { email: "second@example.test", password: "long-enough-password" } });

    expect(response.statusCode).toBe(409);
    expect(audit.inputs.some((event) => event.action === "bootstrap.initial-admin.rejected" && event.metadata?.["reason"] === "locked")).toBe(true);
  });

  it("never persists the submitted password in bootstrap audit metadata", async () => {
    const audit = new InMemoryAuditRepository();
    const submitted = "first-owner-very-secret-password-123";
    const users = new InMemoryAuthUserRepository();

    const created = await buildApiApp({ auth: { audit, users, hasher: new BcryptPasswordHasher(10) } });
    const createdResponse = await created.inject({ method: "POST", url: "/api/v1/bootstrap/initial-admin", headers: contentHeaders, payload: { email: "first@example.test", password: submitted } });
    expect(createdResponse.statusCode).toBe(200);

    const rejectedInvalid = await created.inject({ method: "POST", url: "/api/v1/bootstrap/initial-admin", headers: contentHeaders, payload: { email: "bad", password: "short" } });
    expect(rejectedInvalid.statusCode).toBe(400);

    const second = await created.inject({ method: "POST", url: "/api/v1/bootstrap/initial-admin", headers: contentHeaders, payload: { email: "second@example.test", password: submitted } });
    expect(second.statusCode).toBe(409);

    const bootstrapEvents = audit.inputs.filter((event) => event.action === "bootstrap.initial-admin" || event.action === "bootstrap.initial-admin.rejected");
    expect(bootstrapEvents.length).toBeGreaterThanOrEqual(3);
    for (const event of bootstrapEvents) {
      expect(JSON.stringify(event.metadata ?? {})).not.toContain(submitted);
    }

    await created.close();
  });

  it("maps concurrent atomic bootstrap conflicts to locked without creating a second admin", async () => {
    const audit = new InMemoryAuditRepository();
    const createdUsers: AuthUser[] = [];
    const users: AuthUserRepository = {
      async findByEmail() {
        return null;
      },
      async findById() {
        return null;
      },
      async count() {
        return 0;
      },
      async createInitialAdmin(input: CreateInitialAdminInput) {
        if (createdUsers.length > 0) {
          throw new InitialAdminAlreadyExistsError();
        }
        const user: AuthUser = { id: `user_${createdUsers.length + 1}`, email: input.email, emailNormalized: input.email.toLowerCase(), passwordHash: input.passwordHash, role: "admin", status: "active", createdAt: new Date(), updatedAt: new Date() };
        createdUsers.push(user);
        return user;
      }
    };
    const app = await buildApiApp({ auth: { audit, users, hasher: new BcryptPasswordHasher(10) } });

    const [first, second] = await Promise.all([
      app.inject({ method: "POST", url: "/api/v1/bootstrap/initial-admin", headers: contentHeaders, payload: { email: "first@example.test", password: "long-enough-password" } }),
      app.inject({ method: "POST", url: "/api/v1/bootstrap/initial-admin", headers: contentHeaders, payload: { email: "second@example.test", password: "long-enough-password" } })
    ]);

    expect([first.statusCode, second.statusCode].sort()).toEqual([200, 409]);
    expect(createdUsers).toHaveLength(1);
    expect(audit.inputs.some((event) => event.action === "bootstrap.initial-admin.rejected" && event.metadata?.["reason"] === "locked")).toBe(true);
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

  it("honors string false for HTTP-first production cookies", async () => {
    const hasher = new BcryptPasswordHasher(10);
    const user = { id: "user_http_1", email: "admin@example.test", emailNormalized: "admin@example.test", passwordHash: await hasher.hash(password), role: "admin" as const, status: "active" as const, createdAt: new Date(), updatedAt: new Date() };
    const app = await buildApiApp({
      auth: { hasher, users: new InMemoryAuthUserRepository([user]) },
      env: {
        ...process.env,
        NODE_ENV: "production",
        DEPLOYLITE_SESSION_COOKIE_SECURE: "false"
      }
    });
    const response = await app.inject({ method: "POST", url: "/api/v1/auth/login", headers: contentHeaders, payload: { email: "admin@example.test", password } });

    expect(response.headers["set-cookie"]).not.toContain("Secure");
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
    const { app, audit } = await authFixture({ user: { status: "disabled" } });
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
    const { app, audit } = await authFixture({ user: { role: "read-only" } });
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

  it("returns authenticated metadata list/detail envelopes without infrastructure side effects", async () => {
    const { calls, state } = metadataRepositories();
    const { app } = await authFixture({ dbMode: true, state });
    const cookie = await loginCookie(app);

    const projects = await app.inject({ method: "GET", url: "/api/v1/projects", headers: { cookie, "x-request-id": "req_projects_1" } });
    const agents = await app.inject({ method: "GET", url: "/api/v1/agents", headers: { cookie } });
    const deployments = await app.inject({ method: "GET", url: "/api/v1/deployments", headers: { cookie } });
    const deployment = await app.inject({ method: "GET", url: "/api/v1/deployments/dep-1", headers: { cookie } });
    const logs = await app.inject({ method: "GET", url: "/api/v1/deployments/dep-1/logs", headers: { cookie } });

    expect(projects.statusCode).toBe(200);
    expect(projects.json()).toMatchObject({ data: { projects: [expect.objectContaining({ id: "project-1" })] }, error: null, requestId: "req_projects_1" });
    expect(agents.statusCode).toBe(200);
    expect(agents.json().data.agents).toEqual([expect.objectContaining({ id: "agent-1" })]);
    expect(deployments.statusCode).toBe(200);
    expect(deployments.json().data.deployments).toEqual([expect.objectContaining({ id: "dep-1" })]);
    expect(deployment.statusCode).toBe(200);
    expect(deployment.json().data.deployment).toMatchObject({ id: "dep-1" });
    expect(logs.statusCode).toBe(200);
    expect(logs.json().data.events).toEqual([expect.objectContaining({ sequence: 1 })]);
    expect(calls).toEqual(["projects.list", "agents.list", "deployments.list", "deployments.findById", "deployments.listLogs"]);
    expect(calls).not.toEqual(expect.arrayContaining(["projects.save", "agents.save", "deployments.save", "deployments.appendLog"]));
  });

  it("protects metadata routes with auth and returns empty states", async () => {
    const { state } = metadataRepositories();
    state.projects.list = async () => [];
    state.agents.list = async () => [];
    state.deployments.list = async () => [];
    state.deployments.listLogs = async () => [];
    const { app } = await authFixture({ dbMode: true, state });
    const cookie = await loginCookie(app);

    const unauthenticated = await app.inject({ method: "GET", url: "/api/v1/deployments" });
    const projects = await app.inject({ method: "GET", url: "/api/v1/projects", headers: { cookie } });
    const agents = await app.inject({ method: "GET", url: "/api/v1/agents", headers: { cookie } });
    const deployments = await app.inject({ method: "GET", url: "/api/v1/deployments", headers: { cookie } });
    const logs = await app.inject({ method: "GET", url: "/api/v1/deployments/missing/logs", headers: { cookie } });

    expect(unauthenticated.statusCode).toBe(401);
    expect(projects.json().data).toEqual({ projects: [] });
    expect(agents.json().data).toEqual({ agents: [] });
    expect(deployments.json().data).toEqual({ deployments: [] });
    expect(logs.json().data).toEqual({ events: [] });
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

  it("creates a project with build/run/port, fetches it back, and rejects when port is out of range", async () => {
    const { app } = await authFixture();
    const cookie = await loginCookie(app);

    const create = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers: { ...contentHeaders, cookie },
      payload: { name: "Demo API", repoUrl: "https://github.com/example/demo", defaultBranch: "main", buildCommand: "pnpm install", runCommand: "node server.js", port: 4000 }
    });
    const created = create.json();
    expect(create.statusCode).toBe(200);
    expect(created.data.project).toMatchObject({ name: "Demo API", buildCommand: "pnpm install", runCommand: "node server.js", port: 4000 });

    const detail = await app.inject({ method: "GET", url: `/api/v1/projects/${created.data.project.id}`, headers: { cookie } });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().data.project.id).toBe(created.data.project.id);

    const badPort = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers: { ...contentHeaders, cookie },
      payload: { name: "Bad", repoUrl: "https://github.com/example/bad", defaultBranch: "main", port: 70000 }
    });
    expect(badPort.statusCode).toBe(400);

    const missing = await app.inject({ method: "GET", url: "/api/v1/projects/missing-id", headers: { cookie } });
    expect(missing.statusCode).toBe(404);
  });

  it("updates project config partially, preserves omitted fields, and clears nullable runtime fields", async () => {
    const { app } = await authFixture();
    const cookie = await loginCookie(app);
    const create = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers: { ...contentHeaders, cookie },
      payload: { name: "Editable", repoUrl: "https://github.com/example/editable", defaultBranch: "main", buildCommand: "pnpm build", runCommand: "node server.js", port: 4000 }
    });
    const projectId = create.json().data.project.id;

    const update = await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${projectId}`,
      headers: { ...contentHeaders, cookie, "x-request-id": "req_project_update_1" },
      payload: { name: "Editable renamed", buildCommand: null, runCommand: null, port: null }
    });

    expect(update.statusCode).toBe(200);
    expect(update.json().data.project).toMatchObject({
      id: projectId,
      name: "Editable renamed",
      repoUrl: "https://github.com/example/editable",
      defaultBranch: "main",
      buildCommand: null,
      runCommand: null,
      port: null
    });
    expect(update.json().data.audit).toMatchObject({ action: "project.update", requestId: "req_project_update_1" });

    const detail = await app.inject({ method: "GET", url: `/api/v1/projects/${projectId}`, headers: { cookie } });
    expect(detail.json().data.project.runCommand).toBeNull();
  });

  it("rejects invalid project config updates, read-only callers, and missing projects", async () => {
    const { app } = await authFixture();
    const cookie = await loginCookie(app);
    const create = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers: { ...contentHeaders, cookie },
      payload: { name: "Validation", repoUrl: "https://github.com/example/validation", defaultBranch: "main", port: 3000 }
    });
    const projectId = create.json().data.project.id;

    const invalid = await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${projectId}`,
      headers: { ...contentHeaders, cookie },
      payload: { repoUrl: "not-a-url", port: 70000 }
    });
    expect(invalid.statusCode).toBe(400);

    const missing = await app.inject({
      method: "PATCH",
      url: "/api/v1/projects/missing-project",
      headers: { ...contentHeaders, cookie },
      payload: { name: "Still missing" }
    });
    expect(missing.statusCode).toBe(404);

    const readOnlyFixture = await authFixture({ user: { role: "read-only" } });
    const readOnlyCookie = await loginCookie(readOnlyFixture.app);
    const forbidden = await readOnlyFixture.app.inject({
      method: "PATCH",
      url: "/api/v1/projects/project_mock_1",
      headers: { ...contentHeaders, cookie: readOnlyCookie },
      payload: { name: "Denied" }
    });
    expect(forbidden.statusCode).toBe(403);
  });

  it("manages env metadata as key-only records (no secret values) and never echoes them", async () => {
    const { app } = await authFixture();
    const cookie = await loginCookie(app);

    const create = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers: { ...contentHeaders, cookie },
      payload: { name: "EnvDemo", repoUrl: "https://github.com/example/env", defaultBranch: "main" }
    });
    const projectId = create.json().data.project.id;

    const upsert = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/env-variables`,
      headers: { ...contentHeaders, cookie },
      payload: { key: "DATABASE_URL", scope: "project", required: true, description: "Postgres connection string" }
    });
    expect(upsert.statusCode).toBe(200);
    expect(upsert.json().data.envVariable).toMatchObject({ key: "DATABASE_URL", required: true, valuePresent: false });

    const list = await app.inject({ method: "GET", url: `/api/v1/projects/${projectId}/env-variables`, headers: { cookie } });
    expect(list.statusCode).toBe(200);
    expect(list.json().data.envVariables).toHaveLength(1);
    expect(JSON.stringify(list.json())).not.toContain("value=");
    expect(JSON.stringify(list.json())).not.toContain("plaintextValue");
    expect(JSON.stringify(list.json())).not.toContain("secret");

    const rejectValue = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/env-variables`,
      headers: { ...contentHeaders, cookie },
      payload: { key: "API_KEY", scope: "project", required: false, value: "should-be-rejected" }
    });
    expect(rejectValue.statusCode).toBe(400);
  });

  it("triggers a deploy end-to-end: queued record, log events, status transitions to succeeded", async () => {
    const { app } = await authFixture();
    const cookie = await loginCookie(app);

    const project = (await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers: { ...contentHeaders, cookie },
      payload: { name: "Deployable", repoUrl: "https://github.com/example/deployable", defaultBranch: "main", buildCommand: "pnpm build", runCommand: "node server.js", port: 3000 }
    })).json().data.project;

    const trigger = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${project.id}/deployments`,
      headers: { ...contentHeaders, cookie, "x-request-id": "req_deploy_1" },
      payload: {}
    });
    expect(trigger.statusCode).toBe(200);
    const deployment = trigger.json().data.deployment;
    expect(deployment.status).toBe("queued");
    expect(trigger.json().data.audit).toMatchObject({ action: "deployment.trigger", requestId: "req_deploy_1" });

    const initialLogs = await app.inject({ method: "GET", url: `/api/v1/deployments/${deployment.id}/logs`, headers: { cookie } });
    const initialEvents = initialLogs.json().data.events;
    expect(initialEvents.length).toBeGreaterThan(0);
    expect(initialEvents.some((e: { message: string }) => e.message.includes("Queued deploy"))).toBe(true);
    expect(initialEvents.some((e: { message: string }) => e.message.includes("Build command: pnpm build"))).toBe(true);
    expect(initialEvents.some((e: { message: string }) => e.message.includes("Run command: node server.js"))).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 350));

    const finalDetail = await app.inject({ method: "GET", url: `/api/v1/deployments/${deployment.id}`, headers: { cookie } });
    const finalStatus = finalDetail.json().data.deployment.status;
    expect(["running", "succeeded"]).toContain(finalStatus);

    const finalLogs = await app.inject({ method: "GET", url: `/api/v1/deployments/${deployment.id}/logs`, headers: { cookie } });
    const finalMessages = (finalLogs.json().data.events as Array<{ message: string; sequence: number }>).map((e) => e.message);
    expect(finalMessages.some((m) => m.includes("Queued deploy"))).toBe(true);

    await app.close();
  });

  it("fails a deploy when required env metadata has no value present", async () => {
    const { app } = await authFixture();
    const cookie = await loginCookie(app);

    const project = (await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers: { ...contentHeaders, cookie },
      payload: { name: "NeedsSecret", repoUrl: "https://github.com/example/needs", defaultBranch: "main", runCommand: "node server.js" }
    })).json().data.project;

    await app.inject({
      method: "POST",
      url: `/api/v1/projects/${project.id}/env-variables`,
      headers: { ...contentHeaders, cookie },
      payload: { key: "DATABASE_URL", required: true }
    });

    const trigger = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${project.id}/deployments`,
      headers: { ...contentHeaders, cookie },
      payload: {}
    });
    expect(trigger.statusCode).toBe(200);
    const deployment = trigger.json().data.deployment;
    expect(deployment.status).toBe("failed");
    expect(deployment.finishedAt).not.toBeNull();

    const logs = await app.inject({ method: "GET", url: `/api/v1/deployments/${deployment.id}/logs`, headers: { cookie } });
    expect((logs.json().data.events as Array<{ message: string; level: string }>).some((e) => e.level === "error" && e.message.includes("Refusing to advance"))).toBe(true);

    await app.close();
  });

  it("returns 409 when no agent is available to trigger a deploy", async () => {
    const agents: AgentRepository = {
      async save() { throw new Error("unused"); },
      async findById() { return null; },
      async list() { return []; }
    };
    const projects: ProjectRepository = {
      async save() { throw new Error("unused"); },
      async findById(id) { return id === "project-1" ? { id, name: "X", repoUrl: "https://github.com/example/x", defaultBranch: "main", buildCommand: null, runCommand: null, port: null, description: null } : null; },
      async list() { return []; },
      async remove() { return false; }
    };
    const envRepo: EnvVariableMetadataRepository = {
      async listByProject() { return []; },
      async upsert(record: EnvVariableMetadataRecord) { return record; },
      async remove() { return true; }
    };
    const { app } = await authFixture({ dbMode: true, state: { agents, projects, envMetadata: envRepo, deployments: undefined as never } });
    const cookie = await loginCookie(app);

    const trigger = await app.inject({
      method: "POST",
      url: "/api/v1/projects/project-1/deployments",
      headers: { ...contentHeaders, cookie },
      payload: {}
    });
    expect(trigger.statusCode).toBe(409);
    expect(trigger.json().error.code).toBe("NO_AGENT_AVAILABLE");
  });

  it("persists a project description on create and returns it in detail and audit metadata", async () => {
    const { app } = await authFixture();
    const cookie = await loginCookie(app);

    const create = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers: { ...contentHeaders, cookie, "x-request-id": "req_project_desc_1" },
      payload: { name: "Described", repoUrl: "https://github.com/example/described", defaultBranch: "main", description: "Owns billing automation" }
    });
    expect(create.statusCode).toBe(200);
    const projectId = create.json().data.project.id;
    expect(create.json().data.project).toMatchObject({ description: "Owns billing automation" });
    expect(create.json().data.audit).toMatchObject({ action: "project.create", targetId: projectId, requestId: "req_project_desc_1" });

    const detail = await app.inject({ method: "GET", url: `/api/v1/projects/${projectId}`, headers: { cookie } });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().data.project.description).toBe("Owns billing automation");
  });

  it("clears a project description via PATCH and leaves non-mentioned fields untouched", async () => {
    const { app } = await authFixture();
    const cookie = await loginCookie(app);

    const create = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers: { ...contentHeaders, cookie },
      payload: { name: "Editable", repoUrl: "https://github.com/example/editable-desc", defaultBranch: "main", description: "Staging app" }
    });
    const projectId = create.json().data.project.id;

    const clear = await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${projectId}`,
      headers: { ...contentHeaders, cookie },
      payload: { description: null }
    });
    expect(clear.statusCode).toBe(200);
    expect(clear.json().data.project).toMatchObject({ id: projectId, name: "Editable", description: null });

    const detail = await app.inject({ method: "GET", url: `/api/v1/projects/${projectId}`, headers: { cookie } });
    expect(detail.json().data.project.description).toBeNull();
  });

  it("deletes a project, removes it from list, and audits the deletion", async () => {
    const { app, audit } = await authFixture();
    const cookie = await loginCookie(app);

    const create = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers: { ...contentHeaders, cookie, "x-request-id": "req_project_delete_1" },
      payload: { name: "Disposable", repoUrl: "https://github.com/example/disposable", defaultBranch: "main" }
    });
    const projectId = create.json().data.project.id;

    const deletion = await app.inject({
      method: "DELETE",
      url: `/api/v1/projects/${projectId}`,
      headers: { cookie }
    });
    expect(deletion.statusCode).toBe(200);
    expect(deletion.json().data).toEqual({ removed: true, audit: expect.objectContaining({ action: "project.delete", targetId: projectId }) });

    const detail = await app.inject({ method: "GET", url: `/api/v1/projects/${projectId}`, headers: { cookie } });
    expect(detail.statusCode).toBe(404);

    const list = await app.inject({ method: "GET", url: "/api/v1/projects", headers: { cookie } });
    expect(list.json().data.projects.find((p: { id: string }) => p.id === projectId)).toBeUndefined();

    expect(audit.events.some((event) => event.action === "project.delete" && event.targetId === projectId)).toBe(true);
  });

  it("rejects DELETE for read-only callers, missing projects, and unauthenticated requests", async () => {
    const { app, audit } = await authFixture();
    const adminCookie = await loginCookie(app);

    const create = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers: { ...contentHeaders, cookie: adminCookie },
      payload: { name: "Locked", repoUrl: "https://github.com/example/locked", defaultBranch: "main" }
    });
    const projectId = create.json().data.project.id;

    const unauthenticated = await app.inject({ method: "DELETE", url: `/api/v1/projects/${projectId}` });
    expect(unauthenticated.statusCode).toBe(401);

    const missing = await app.inject({ method: "DELETE", url: "/api/v1/projects/does-not-exist", headers: { cookie: adminCookie } });
    expect(missing.statusCode).toBe(404);

    const readOnlyFixture = await authFixture({ user: { role: "read-only" } });
    const readOnlyCookie = await loginCookie(readOnlyFixture.app);
    const forbidden = await readOnlyFixture.app.inject({ method: "DELETE", url: `/api/v1/projects/${projectId}`, headers: { cookie: readOnlyCookie } });
    expect(forbidden.statusCode).toBe(403);
    expect(audit.events.some((event) => event.action === "project.delete" && event.targetId === projectId)).toBe(false);
  });
});

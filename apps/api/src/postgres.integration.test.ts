import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";

import { closeDbPool, createDbClient, createDbPool, DbAgentRepository, DbDeploymentRepository, DbProjectRepository, type DeployLiteDb } from "@deploylite/db";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApiApp } from "./app.js";

const localDatabaseUrl = "postgres://deploylite:deploylite@localhost:55433/deploylite";
const integrationEnabled = process.env.DEPLOYLITE_API_POSTGRES_INTEGRATION === "1";
const describeIntegration = integrationEnabled ? describe : describe.skip;
const contentHeaders = { "content-type": "application/json" };
const adminPassword = "correct horse battery staple";

let maintenancePool: ReturnType<typeof createDbPool> | null = null;
let pool: ReturnType<typeof createDbPool> | null = null;
let db: DeployLiteDb | null = null;
let databaseName = "";
let databaseUrl = "";

describeIntegration("DeployLite API PostgreSQL integration", () => {
  beforeAll(async () => {
    const configuredUrl = process.env.DATABASE_URL ?? localDatabaseUrl;
    databaseName = `deploylite_api_verify_${randomUUID().replaceAll("-", "_")}`;

    const maintenanceUrl = new URL(configuredUrl);
    maintenanceUrl.pathname = "/postgres";
    maintenancePool = createDbPool(maintenanceUrl.toString(), { max: 1 });
    await maintenancePool.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);

    const testDatabaseUrl = new URL(configuredUrl);
    testDatabaseUrl.pathname = `/${databaseName}`;
    databaseUrl = testDatabaseUrl.toString();

    await applyMigrations(databaseUrl);
    pool = createDbPool(databaseUrl, { max: 2 });
    db = createDbClient(pool);
  }, 30_000);

  afterAll(async () => {
    if (pool) {
      await closeDbPool(pool);
      pool = null;
      db = null;
    }

    if (maintenancePool && databaseName) {
      await maintenancePool.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
      await closeDbPool(maintenancePool);
      maintenancePool = null;
    }
  }, 30_000);

  it("verifies bootstrap, restart-stable login, logout revocation, metadata persistence, and log reads", async () => {
    const firstApp = await createPostgresApp();

    const status = await firstApp.inject({ method: "GET", url: "/api/v1/bootstrap/status" });
    expect(status.statusCode).toBe(200);
    expect(status.json().data).toEqual({ setupRequired: true });

    const bootstrap = await firstApp.inject({
      method: "POST",
      url: "/api/v1/bootstrap/initial-admin",
      headers: contentHeaders,
      payload: { email: "Admin@Example.TEST", password: adminPassword }
    });
    expect(bootstrap.statusCode).toBe(200);
    expect(bootstrap.json().data.user).toMatchObject({ email: "Admin@Example.TEST", role: "admin", status: "active" });

    const locked = await firstApp.inject({ method: "GET", url: "/api/v1/bootstrap/status" });
    expect(locked.json().data).toEqual({ setupRequired: false });

    const login = await firstApp.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: contentHeaders,
      payload: { email: "admin@example.test", password: adminPassword }
    });
    expect(login.statusCode).toBe(200);
    const cookie = login.headers["set-cookie"] as string;
    expect(cookie).toContain("dl_pg_session=");

    const projectId = randomUUID();
    const agentId = randomUUID();
    const deploymentId = randomUUID();
    await new DbProjectRepository(requireDb()).save({
      id: projectId,
      name: "PostgreSQL project",
      repoUrl: "https://github.com/example/deploylite-postgres",
      defaultBranch: "main",
      buildCommand: "pnpm build",
      runCommand: "pnpm start",
      port: 3000,
      description: null,
      imageTag: null
    });
    await new DbAgentRepository(requireDb()).save({
      id: agentId,
      name: "PostgreSQL agent",
      endpoint: "https://agent.postgres.test",
      status: "online",
      lastHeartbeatAt: null,
      resourceSnapshot: null
    });
    const deploymentsRepo = new DbDeploymentRepository(requireDb());
    await deploymentsRepo.save({
      id: deploymentId,
      projectId,
      agentId,
      status: "running",
      commitSha: "abcdef1234567890",
      startedAt: new Date().toISOString(),
      finishedAt: null
    });
    await deploymentsRepo.appendLog({
      id: randomUUID(),
      deploymentId,
      sequence: 1,
      level: "info",
      message: "PostgreSQL integration log token dl_1234567890abcdef should be redacted",
      timestamp: new Date().toISOString(),
      redactionApplied: false,
      requestId: "req_api_pg_integration",
      correlationId: "corr_api_pg_integration"
    });

    await firstApp.close();
    const restartedApp = await createPostgresApp();

    const meAfterRestart = await restartedApp.inject({ method: "GET", url: "/api/v1/auth/me", headers: { cookie } });
    expect(meAfterRestart.statusCode).toBe(200);
    expect(meAfterRestart.json().data.user.email).toBe("Admin@Example.TEST");

    const projects = await restartedApp.inject({ method: "GET", url: "/api/v1/projects", headers: { cookie } });
    const agents = await restartedApp.inject({ method: "GET", url: "/api/v1/agents", headers: { cookie } });
    const deployments = await restartedApp.inject({ method: "GET", url: "/api/v1/deployments", headers: { cookie } });
    const logs = await restartedApp.inject({ method: "GET", url: `/api/v1/deployments/${deploymentId}/logs`, headers: { cookie } });

    expect(projects.json().data.projects).toEqual([expect.objectContaining({ id: projectId, name: "PostgreSQL project" })]);
    expect(agents.json().data.agents).toEqual([expect.objectContaining({ id: agentId, name: "PostgreSQL agent" })]);
    expect(deployments.json().data.deployments).toEqual([expect.objectContaining({ id: deploymentId, projectId, agentId })]);
    expect(logs.json().data.events).toEqual([
      expect.objectContaining({ deploymentId, sequence: 1, message: expect.stringContaining("[REDACTED]"), redactionApplied: true })
    ]);
    expect(JSON.stringify(logs.json())).not.toContain("dl_1234567890abcdef");

    const logout = await restartedApp.inject({ method: "POST", url: "/api/v1/auth/logout", headers: { cookie } });
    expect(logout.statusCode).toBe(200);
    const afterLogout = await restartedApp.inject({ method: "GET", url: "/api/v1/auth/me", headers: { cookie } });
    expect(afterLogout.statusCode).toBe(401);

    await restartedApp.close();
  }, 30_000);

  it("persists the confirmed delete command and correlated audit while making replay idempotent", async () => {
    const app = await createPostgresApp();
    const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", headers: contentHeaders, payload: { email: "admin@example.test", password: adminPassword } });
    const cookie = login.headers["set-cookie"] as string;
    const projectId = randomUUID();
    await new DbProjectRepository(requireDb()).save({ id: projectId, name: "Confirmed PostgreSQL project", repoUrl: "https://github.com/example/confirmed-postgres", defaultBranch: "main", buildCommand: null, runCommand: null, port: null, description: null, imageTag: null });
    const headers = { cookie, "x-control-idempotency-key": "postgres-confirmed-delete" };

    const pending = await app.inject({ method: "DELETE", url: `/api/v1/projects/${projectId}`, headers });
    expect(pending.statusCode).toBe(202);
    const { commandId, confirmationId } = pending.json().data;

    const completed = await app.inject({ method: "DELETE", url: `/api/v1/projects/${projectId}`, headers: { ...headers, "x-control-confirmation-id": confirmationId } });
    expect(completed.statusCode).toBe(200);
    const replay = await app.inject({ method: "DELETE", url: `/api/v1/projects/${projectId}`, headers: { ...headers, "x-control-confirmation-id": confirmationId } });
    expect(replay.json().data).toMatchObject({ removed: true, commandId, idempotent: true });

    const audit = await requirePool().query<{ outcome: string; correlation_id: string; consumed_at: Date | null; status: string }>("SELECT a.outcome, a.correlation_id, c.consumed_at, cmd.status FROM control_command_audits a JOIN control_command_confirmations c ON c.id = a.confirmation_id JOIN control_commands cmd ON cmd.id = a.command_id WHERE a.command_id = $1", [commandId]);
    expect(audit.rows).toEqual([expect.objectContaining({ outcome: "completed", status: "completed", consumed_at: expect.any(Date) })]);
    expect(audit.rows[0]?.correlation_id).toBeTruthy();
    await expect(requirePool().query("SELECT id FROM audit_events WHERE correlation_id = $1 AND action = 'project.delete' AND target_id = $2", [audit.rows[0]?.correlation_id, projectId])).resolves.toMatchObject({ rowCount: 1 });
    await app.close();
  }, 30_000);
});

async function createPostgresApp(): Promise<FastifyInstance> {
  return buildApiApp({
    authConfig: { cookieName: "dl_pg_session", cookieSecure: false, sessionTtlSeconds: 3600 },
    db: { pool: requirePool(), client: requireDb() },
    env: { ...process.env, NODE_ENV: "test", DATABASE_URL: databaseUrl, DEPLOYLITE_BCRYPT_COST: "10", DEPLOYLITE_CONTROL_PLANE_CONFIRMED_DELETE: "true" }
  });
}

function requirePool(): ReturnType<typeof createDbPool> {
  if (!pool) {
    throw new Error("PostgreSQL integration pool is not initialized");
  }

  return pool;
}

function requireDb(): DeployLiteDb {
  if (!db) {
    throw new Error("PostgreSQL integration client is not initialized");
  }

  return db;
}

async function applyMigrations(connectionString: string): Promise<void> {
  const migrationPool = createDbPool(connectionString, { max: 1 });

  try {
    const migrationsUrl = new URL("../../../packages/db/migrations/", import.meta.url);
    const migrationFiles = (await readdir(migrationsUrl)).filter((file) => file.endsWith(".sql")).sort();

    for (const file of migrationFiles) {
      const sql = await readFile(new URL(file, migrationsUrl), "utf8");
      await migrationPool.query(sql);
    }
  } finally {
    await closeDbPool(migrationPool);
  }
}

function quoteIdentifier(identifier: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(identifier)) {
    throw new Error(`Unsafe PostgreSQL identifier: ${identifier}`);
  }

  return `"${identifier}"`;
}

import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";

import { closeDbPool, createDbClient, createDbPool, DbAgentRepository, DbDeploymentCommandRepository, DbDeploymentRepository, DbProjectRepository, type DeployLiteDb } from "@deploylite/db";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApiApp } from "./app.js";

const localDatabaseUrl = "postgres://deploylite:deploylite@localhost:55433/deploylite";
const integrationEnabled = process.env.DEPLOYLITE_API_POSTGRES_INTEGRATION === "1";
const describeIntegration = integrationEnabled ? describe : describe.skip;
const contentHeaders = { "content-type": "application/json" };
const adminPassword = "correct horse battery staple";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

    const registeredAgent = await firstApp.inject({
      method: "POST",
      url: "/api/v1/agents/register",
      headers: { ...contentHeaders, cookie },
      payload: { name: "API-created PostgreSQL agent", endpoint: "https://api-agent.postgres.test" }
    });
    expect(registeredAgent.statusCode).toBe(200);
    const apiAgentId = registeredAgent.json().data.agent.id as string;
    const heartbeat = await firstApp.inject({
      method: "POST",
      url: `/api/v1/agents/${apiAgentId}/heartbeat`,
      headers: { ...contentHeaders, cookie },
      payload: {
        observedAt: new Date().toISOString(),
        resourceSnapshot: { cpuLoad: 0.1, memoryUsedBytes: 1, memoryTotalBytes: 2, diskUsedBytes: 1, diskTotalBytes: 2 }
      }
    });
    expect(heartbeat.statusCode).toBe(200);
    const createdProject = await firstApp.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers: { ...contentHeaders, cookie },
      payload: { name: "API-created PostgreSQL project", repoUrl: "https://github.com/example/api-created-postgres", defaultBranch: "main", runCommand: "node server.js" }
    });
    const apiProjectId = createdProject.json().data.project.id as string;
    const triggeredDeployment = await firstApp.inject({
      method: "POST",
      url: `/api/v1/projects/${apiProjectId}/deployments`,
      headers: { ...contentHeaders, cookie },
      payload: { agentId: apiAgentId, commitSha: "abcdef1" }
    });
    const apiDeploymentId = triggeredDeployment.json().data.deployment.id as string;
    const [apiCommand] = await new DbDeploymentCommandRepository(requireDb()).list();

    expect(createdProject.statusCode).toBe(200);
    expect(triggeredDeployment.statusCode).toBe(200);
    expect(apiAgentId).toMatch(UUID_PATTERN);
    expect(apiProjectId).toMatch(UUID_PATTERN);
    expect(apiDeploymentId).toMatch(UUID_PATTERN);
    expect(apiCommand).toMatchObject({ deploymentId: apiDeploymentId, agentId: apiAgentId });
    expect(apiCommand?.id).toMatch(UUID_PATTERN);

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

    expect(projects.json().data.projects).toEqual(expect.arrayContaining([expect.objectContaining({ id: projectId, name: "PostgreSQL project" })]));
    expect(agents.json().data.agents).toEqual(expect.arrayContaining([expect.objectContaining({ id: agentId, name: "PostgreSQL agent" })]));
    expect(deployments.json().data.deployments).toEqual(expect.arrayContaining([expect.objectContaining({ id: deploymentId, projectId, agentId })]));
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

  it("atomically projects real-agent terminal acknowledgements and preserves retry/cancel authority", async () => {
    const projectId = randomUUID();
    const agentId = randomUUID();
    const deploymentId = randomUUID();
    const commandId = randomUUID();
    const token = "postgres-real-agent-token-with-at-least-32-characters";
    const db = requireDb();
    const projects = new DbProjectRepository(db);
    const agents = new DbAgentRepository(db);
    const deployments = new DbDeploymentRepository(db);
    const commands = new DbDeploymentCommandRepository(db);
    const now = new Date();
    await projects.save({ id: projectId, name: "Agent terminal project", repoUrl: "https://github.com/example/agent-terminal", defaultBranch: "main", buildCommand: null, runCommand: "node server.js", port: 3000, description: null, imageTag: null });
    await agents.save({ id: agentId, name: "Agent terminal", endpoint: "https://agent.example.test", status: "online", lastHeartbeatAt: now.toISOString(), resourceSnapshot: null });
    await deployments.save({ id: deploymentId, projectId, agentId, status: "running", commitSha: "abcdef1", startedAt: now.toISOString(), finishedAt: null });
    await commands.save({ id: commandId, deploymentId, agentId, kind: "start", state: "pending", payload: {}, requestedBy: null, requestId: "req_pg_agent", correlationId: "corr_pg_agent", issuedAt: now.toISOString(), claimedAt: null, leaseExpiresAt: null, completedAt: null, failureReason: null });
    await commands.claim(commandId, agentId, now.toISOString(), new Date(now.getTime() + 60_000).toISOString());
    const app = await createPostgresApp({ agentId, token });
    const headers = { ...contentHeaders, authorization: `Bearer ${token}` };
    const first = await app.inject({ method: "POST", url: `/api/v1/agent/commands/${commandId}/complete`, headers, payload: { output: { secret: "sk_1234567890secret" } } });
    const retry = await app.inject({ method: "POST", url: `/api/v1/agent/commands/${commandId}/complete`, headers, payload: {} });
    expect(first.statusCode).toBe(200);
    expect(retry.statusCode).toBe(200);
    expect(await commands.findById(commandId)).toMatchObject({ state: "completed" });
    expect(await deployments.findById(deploymentId)).toMatchObject({ status: "succeeded" });
    expect(await deployments.listLogs(deploymentId)).toEqual([expect.objectContaining({ message: "Agent completed deployment command; deployment succeeded.", requestId: "req_pg_agent" })]);
    expect(await requirePool().query("SELECT action FROM audit_events WHERE target_id = $1", [commandId])).toMatchObject({ rows: [expect.objectContaining({ action: "deployment.command.completed" })] });
    await commands.cancel(commandId, null, new Date().toISOString());
    expect((await commands.findById(commandId))?.state).toBe("completed");
    const failedDeploymentId = randomUUID();
    const failedCommandId = randomUUID();
    await deployments.save({ id: failedDeploymentId, projectId, agentId, status: "running", commitSha: "abcdef2", startedAt: now.toISOString(), finishedAt: null });
    await commands.save({ id: failedCommandId, deploymentId: failedDeploymentId, agentId, kind: "start", state: "pending", payload: {}, requestedBy: null, requestId: "req_pg_agent_fail", correlationId: "corr_pg_agent_fail", issuedAt: now.toISOString(), claimedAt: null, leaseExpiresAt: null, completedAt: null, failureReason: null });
    await commands.claim(failedCommandId, agentId, now.toISOString(), new Date(now.getTime() + 60_000).toISOString());
    const failure = await app.inject({ method: "POST", url: `/api/v1/agent/commands/${failedCommandId}/fail`, headers, payload: { reason: "agent build failed" } });
    expect(failure.statusCode).toBe(200);
    expect(await commands.findById(failedCommandId)).toMatchObject({ state: "failed", failureReason: "agent build failed" });
    expect(await deployments.findById(failedDeploymentId)).toMatchObject({ status: "failed" });
    expect(await deployments.listLogs(failedDeploymentId)).toEqual([expect.objectContaining({ message: "Agent reported deployment failure: agent build failed", requestId: "req_pg_agent_fail" })]);
    expect(await requirePool().query("SELECT action FROM audit_events WHERE target_id = $1", [failedCommandId])).toMatchObject({ rows: [expect.objectContaining({ action: "deployment.command.failed" })] });
    await app.close();
  }, 30_000);
});

async function createPostgresApp(agent?: { agentId: string; token: string }): Promise<FastifyInstance> {
  return buildApiApp({
    authConfig: { cookieName: "dl_pg_session", cookieSecure: false, sessionTtlSeconds: 3600 },
    db: { pool: requirePool(), client: requireDb() },
    env: { ...process.env, NODE_ENV: "test", DATABASE_URL: databaseUrl, DEPLOYLITE_BCRYPT_COST: "10", ...(agent ? { DEPLOYLITE_AGENT_ID: agent.agentId, DEPLOYLITE_AGENT_TOKEN: agent.token } : {}) }
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

import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDbClient, createDbPool, closeDbPool, type DeployLiteDb } from "./client.js";
import { assertEnvMetadataHasNoValueColumns, toEnvVariableMetadataInsert } from "./env-metadata.js";
import { DbAuthUserRepository, DbRoleRepository, DbSessionRepository } from "./repositories/auth.js";
import { DbAgentRepository, DbDeploymentRepository, DbProjectRepository } from "./repositories/deployment-data.js";
import { DbDeploymentCommandRepository } from "./repositories/deployment-commands.js";

const { Client } = pg;

const localDatabaseUrl = "postgres://deploylite:deploylite@localhost:55433/deploylite";
const integrationEnabled = process.env.DEPLOYLITE_DB_INTEGRATION === "1";
const describeIntegration = integrationEnabled ? describe : describe.skip;

let maintenanceClient: pg.Client | null = null;
let databaseName = "";
let databaseUrl = "";
let pool: pg.Pool | null = null;
let db: DeployLiteDb | null = null;

describeIntegration("PostgreSQL auth foundation integration", () => {
  beforeAll(async () => {
    const configuredUrl = process.env.DATABASE_URL ?? localDatabaseUrl;
    databaseName = `deploylite_verify_${randomUUID().replaceAll("-", "_")}`;

    const maintenanceUrl = new URL(configuredUrl);
    maintenanceUrl.pathname = "/postgres";
    maintenanceClient = new Client({ connectionString: maintenanceUrl.toString() });
    await maintenanceClient.connect();
    await maintenanceClient.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);

    const testDatabaseUrl = new URL(configuredUrl);
    testDatabaseUrl.pathname = `/${databaseName}`;
    databaseUrl = testDatabaseUrl.toString();

    await applyMigrations(databaseUrl);

    pool = createDbPool(databaseUrl, { max: 1 });
    db = createDbClient(pool);
  }, 30_000);

  afterAll(async () => {
    if (pool) {
      await closeDbPool(pool);
      pool = null;
      db = null;
    }

    if (maintenanceClient && databaseName) {
      await maintenanceClient.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
      await maintenanceClient.end();
      maintenanceClient = null;
    }
  }, 30_000);

  it("applies migrations to an empty database and seeds canonical roles", async () => {
    const roles = await requireDbRoleRepository().list();

    expect(roles.map((role) => role.name).sort()).toEqual(["admin", "auditor", "operator", "read-only"]);
  });

  it("rejects invalid roles, user FK/status, and env metadata constraints", async () => {
    const client = requirePool();
    const adminRole = (await client.query<{ id: string }>("SELECT id FROM roles WHERE name = 'admin'")).rows.at(0);

    if (!adminRole) {
      throw new Error("Canonical admin role was not seeded");
    }

    await expect(client.query("INSERT INTO roles (name, description) VALUES ('owner', 'Legacy owner')")).rejects.toThrow();
    await expect(
      client.query("INSERT INTO users (email, email_normalized, password_hash, role_id) VALUES ($1, $2, $3, gen_random_uuid())", [
        "fk@example.test",
        "fk@example.test",
        "hash"
      ])
    ).rejects.toThrow();
    await expect(
      client.query("INSERT INTO users (email, email_normalized, password_hash, role_id, status) VALUES ($1, $2, $3, $4, 'locked')", [
        "status@example.test",
        "status@example.test",
        "hash",
        adminRole.id
      ])
    ).rejects.toThrow();
    await expect(
      client.query("INSERT INTO env_variable_metadata (project_id, key, scope) VALUES (gen_random_uuid(), 'TOKEN', 'global')")
    ).rejects.toThrow();
    await expect(
      client.query("INSERT INTO env_variable_metadata (project_id, key, scope) VALUES (gen_random_uuid(), 'TOKEN', 'project')")
    ).rejects.toThrow();
  });

  it("persists auth users and sessions across a new PostgreSQL client lifecycle", async () => {
    const users = requireDbAuthUserRepository();
    const sessions = requireDbSessionRepository();
    const createdUser = await users.createInitialAdmin({ email: "Admin@Example.TEST", passwordHash: "$2b$04$integrationhash" });
    const createdSession = await sessions.create({
      userId: createdUser.id,
      tokenHash: "sha256:integration-token-hash",
      expiresAt: new Date(Date.now() + 60_000),
      ipHash: "sha256:ip",
      userAgent: "deploylite-integration-test"
    });

    await closeDbPool(requirePool());
    pool = createDbPool(databaseUrl, { max: 1 });
    db = createDbClient(pool);

    await expect(requireDbAuthUserRepository().findByEmail("admin@example.test")).resolves.toMatchObject({
      id: createdUser.id,
      email: "Admin@Example.TEST",
      role: "admin",
      status: "active"
    });
    await expect(requireDbSessionRepository().findValidByTokenHash("sha256:integration-token-hash")).resolves.toMatchObject({
      id: createdSession.id,
      userId: createdUser.id,
      tokenHash: "sha256:integration-token-hash"
    });
  });

  it("persists deployment metadata foundations across a new PostgreSQL client lifecycle", async () => {
    const client = requirePool();
    const now = new Date().toISOString();
    const serverId = randomUUID();
    const agentId = randomUUID();
    const projectId = randomUUID();
    const deploymentId = randomUUID();
    const deploymentLogId = randomUUID();
    const domainId = randomUUID();
    const certificateId = randomUUID();
    const envMetadataId = randomUUID();

    await client.query(
      "INSERT INTO servers (id, name, endpoint, status, metadata) VALUES ($1, $2, $3, $4, $5::jsonb)",
      [serverId, "Integration server", "https://server.integration.test", "online", JSON.stringify({ region: "local" })]
    );

    await requireDbAgentRepository().save({
      id: agentId,
      name: "Integration agent",
      endpoint: "https://agent.integration.test",
      status: "online",
      lastHeartbeatAt: now,
      resourceSnapshot: {
        cpuLoad: 0.25,
        memoryUsedBytes: 128,
        memoryTotalBytes: 1024,
        diskUsedBytes: 256,
        diskTotalBytes: 2048
      }
    });
    await client.query("UPDATE agents SET server_id = $1 WHERE id = $2", [serverId, agentId]);

    await requireDbProjectRepository().save({
      id: projectId,
      name: "Integration project",
      repoUrl: "https://github.com/example/deploylite-integration",
      defaultBranch: "main",
      buildCommand: "pnpm build",
      runCommand: "pnpm start",
      port: 3000,
      description: null,
      imageTag: null
    });

    await requireDbDeploymentRepository().save({
      id: deploymentId,
      projectId,
      agentId,
      status: "running",
      commitSha: "abcdef1234567890",
      startedAt: now,
      finishedAt: null
    });
    const finishedAt = new Date().toISOString();
    await requireDbDeploymentRepository().save({
      id: deploymentId,
      projectId,
      agentId,
      status: "succeeded",
      commitSha: "abcdef1234567890",
      startedAt: now,
      finishedAt
    });
    await requireDbDeploymentRepository().appendLog({
      id: deploymentLogId,
      deploymentId,
      sequence: 1,
      level: "info",
      message: "Deployment metadata persisted with secret token=plain-text removed",
      timestamp: now,
      redactionApplied: false,
      requestId: "req-integration-metadata",
      correlationId: "corr-integration-metadata"
    });

    await client.query(
      "INSERT INTO domains (id, project_id, hostname, status, metadata) VALUES ($1, $2, $3, $4, $5::jsonb)",
      [domainId, projectId, "integration.deploylite.test", "active", JSON.stringify({ source: "integration-test" })]
    );
    await client.query(
      "INSERT INTO certificates (id, domain_id, provider, status, not_before, not_after, metadata) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)",
      [
        certificateId,
        domainId,
        "acme-metadata-only",
        "issued",
        new Date(Date.now() - 60_000),
        new Date(Date.now() + 86_400_000),
        JSON.stringify({ issuer: "metadata-only" })
      ]
    );
    await client.query(
      "INSERT INTO env_variable_metadata (id, project_id, key, scope, value_present, value_fingerprint, metadata) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)",
      [
        envMetadataId,
        projectId,
        "DEPLOYLITE_TOKEN",
        "project",
        false,
        null,
        JSON.stringify({ description: "metadata only" })
      ]
    );

    await closeDbPool(requirePool());
    pool = createDbPool(databaseUrl, { max: 1 });
    db = createDbClient(pool);

    await expect(requireDbAgentRepository().findById(agentId)).resolves.toMatchObject({
      id: agentId,
      name: "Integration agent",
      endpoint: "https://agent.integration.test",
      status: "online"
    });
    await expect(requireDbProjectRepository().list()).resolves.toContainEqual(expect.objectContaining({
      id: projectId,
      name: "Integration project",
      repoUrl: "https://github.com/example/deploylite-integration",
      defaultBranch: "main"
    }));
    await expect(requireDbDeploymentRepository().findById(deploymentId)).resolves.toMatchObject({
      id: deploymentId,
      projectId,
      agentId,
      status: "succeeded",
      commitSha: "abcdef1234567890"
    });
    await expect(requireDbDeploymentRepository().listLogs(deploymentId)).resolves.toEqual([
      expect.objectContaining({
        id: deploymentLogId,
        deploymentId,
        sequence: 1,
        level: "info",
        redactionApplied: true
      })
    ]);

    const reopenedClient = requirePool();
    await expect(reopenedClient.query("SELECT id, name, status, metadata FROM servers WHERE id = $1", [serverId])).resolves.toMatchObject({
      rows: [expect.objectContaining({ id: serverId, name: "Integration server", status: "online", metadata: { region: "local" } })]
    });
    await expect(reopenedClient.query("SELECT id, hostname, status, metadata FROM domains WHERE id = $1", [domainId])).resolves.toMatchObject({
      rows: [expect.objectContaining({ id: domainId, hostname: "integration.deploylite.test", status: "active", metadata: { source: "integration-test" } })]
    });
    await expect(reopenedClient.query("SELECT id, provider, status, metadata FROM certificates WHERE id = $1", [certificateId])).resolves.toMatchObject({
      rows: [expect.objectContaining({ id: certificateId, provider: "acme-metadata-only", status: "issued", metadata: { issuer: "metadata-only" } })]
    });
    await expect(
      reopenedClient.query("SELECT id, key, scope, value_present, value_fingerprint, metadata FROM env_variable_metadata WHERE id = $1", [
        envMetadataId
      ])
    ).resolves.toMatchObject({
      rows: [
        expect.objectContaining({
          id: envMetadataId,
          key: "DEPLOYLITE_TOKEN",
          scope: "project",
          value_present: false,
          value_fingerprint: null,
          metadata: { description: "metadata only" }
        })
      ]
    });
  });

  it("keeps env metadata value-free at helper and PostgreSQL column boundaries", async () => {
    const client = requirePool();
    const columns = (
      await client.query<{ column_name: string }>(
        "SELECT column_name FROM information_schema.columns WHERE table_name = 'env_variable_metadata' ORDER BY ordinal_position"
      )
    ).rows.map((row) => row.column_name);

    expect(assertEnvMetadataHasNoValueColumns(columns)).toBe(true);
    expect(columns).not.toContain("value");
    expect(columns).not.toContain("secret");
    expect(columns).not.toContain("encrypted_value");
    expect(() =>
      toEnvVariableMetadataInsert({
        projectId: randomUUID(),
        key: "TOKEN",
        scope: "project",
        value: "plain-text-secret"
      } as Parameters<typeof toEnvVariableMetadataInsert>[0])
    ).toThrow("Environment variable metadata cannot include secret value field");
  });

  it("deduplicates a running projection retry with a changed message, preserving its first redacted log and one audit event", async () => {
    const client = requirePool();
    const live = await seedClaimedProjectionFixture("live", new Date(Date.now() + 60_000).toISOString());
    const repository = new DbDeploymentCommandRepository(requireDb());
    const projection = runningProjection(live);

    await expect(repository.projectRunning(live.commandId, live.agentId, projection)).resolves.toMatchObject({ applied: true, command: { state: "executing" } });
    await expect(repository.projectRunning(live.commandId, live.agentId, {
      ...projection,
      log: { ...projection.log, id: randomUUID(), message: "retry token dl_fedcba0987654321" }
    })).resolves.toMatchObject({ applied: false });
    await expect(client.query("SELECT status FROM deployments WHERE id = $1", [live.deploymentId])).resolves.toMatchObject({ rows: [{ status: "running" }] });
    await expect(client.query("SELECT sequence, message, redaction_applied FROM deployment_logs WHERE deployment_id = $1", [live.deploymentId])).resolves.toMatchObject({ rows: [{ sequence: 1, message: "running token [REDACTED]", redaction_applied: true }] });
    await expect(client.query("SELECT count(*)::int AS count FROM deployment_logs WHERE deployment_id = $1 AND message LIKE 'retry%'", [live.deploymentId])).resolves.toMatchObject({ rows: [{ count: 0 }] });
    await expect(client.query("SELECT count(*)::int AS count FROM audit_events WHERE request_id = $1", [live.requestId])).resolves.toMatchObject({ rows: [{ count: 1 }] });
    await expect(client.query("SELECT metadata FROM audit_events WHERE request_id = $1", [live.requestId])).resolves.toMatchObject({ rows: [{ metadata: { token: "[REDACTED]" } }] });

    for (const leaseExpiresAt of [new Date().toISOString(), new Date(Date.now() - 60_000).toISOString()]) {
      const rejected = await seedClaimedProjectionFixture(`rejected_${leaseExpiresAt}`, leaseExpiresAt);
      await expect(repository.projectRunning(rejected.commandId, rejected.agentId, runningProjection(rejected))).resolves.toMatchObject({ applied: false });
      await expect(client.query("SELECT status FROM deployments WHERE id = $1", [rejected.deploymentId])).resolves.toMatchObject({ rows: [{ status: "queued" }] });
      await expect(client.query("SELECT count(*)::int AS count FROM deployment_logs WHERE deployment_id = $1", [rejected.deploymentId])).resolves.toMatchObject({ rows: [{ count: 0 }] });
    }
  });

  it("advances allocation beyond an explicitly appended log sequence", async () => {
    const fixture = await seedClaimedProjectionFixture("explicit_sequence", new Date(Date.now() + 60_000).toISOString());
    const repository = new DbDeploymentRepository(requireDb());

    await repository.appendLog({ id: randomUUID(), deploymentId: fixture.deploymentId, sequence: 7, level: "info", message: "explicit", timestamp: fixture.now, redactionApplied: false, requestId: fixture.requestId, correlationId: fixture.correlationId });
    await expect(repository.appendAllocatedLog({ id: randomUUID(), deploymentId: fixture.deploymentId, level: "info", message: "allocated", timestamp: fixture.now, redactionApplied: false, requestId: fixture.requestId, correlationId: fixture.correlationId })).resolves.toMatchObject({ sequence: 8 });
  });

  it("does not project running effects when cancellation wins after the lease fence is read", async () => {
    const client = requirePool();
    const fixture = await seedClaimedProjectionFixture("cancel_after_fence", new Date(Date.now() + 60_000).toISOString());
    let releaseFence: (() => void) | undefined;
    let signalFenceRead: (() => void) | undefined;
    const fenceRead = new Promise<void>((resolve) => { signalFenceRead = resolve; });
    const resumeProjection = new Promise<void>((resolve) => { releaseFence = resolve; });
    const racePool = createDbPool(databaseUrl, { max: 2 });
    const raceDb = createDbClient(racePool);

    try {
      const running = new DbDeploymentCommandRepository(raceDb, {
        afterFenceRead: async () => {
          signalFenceRead?.();
          await resumeProjection;
        }
      }).projectRunning(fixture.commandId, fixture.agentId, runningProjection(fixture));
      await fenceRead;
      await expect(new DbDeploymentCommandRepository(raceDb).cancel(fixture.commandId, null, new Date().toISOString())).resolves.toMatchObject({ applied: true, command: { state: "cancelled" } });
      releaseFence?.();

      await expect(running).resolves.toMatchObject({ applied: false, command: { state: "cancelled" } });
      await expect(client.query("SELECT status FROM deployments WHERE id = $1", [fixture.deploymentId])).resolves.toMatchObject({ rows: [{ status: "queued" }] });
      await expect(client.query("SELECT count(*)::int AS count FROM deployment_logs WHERE deployment_id = $1", [fixture.deploymentId])).resolves.toMatchObject({ rows: [{ count: 0 }] });
    } finally {
      await closeDbPool(racePool);
    }
  });

  it("rolls back running projection when its audit write cannot commit", async () => {
    const client = requirePool();
    const fixture = await seedClaimedProjectionFixture("rollback", new Date(Date.now() + 60_000).toISOString());
    const projection = runningProjection(fixture, randomUUID());

    await expect(new DbDeploymentCommandRepository(requireDb()).projectRunning(fixture.commandId, fixture.agentId, projection)).rejects.toThrow();
    await expect(client.query("SELECT status FROM deployments WHERE id = $1", [fixture.deploymentId])).resolves.toMatchObject({ rows: [{ status: "queued" }] });
    await expect(client.query("SELECT count(*)::int AS count FROM deployment_logs WHERE deployment_id = $1", [fixture.deploymentId])).resolves.toMatchObject({ rows: [{ count: 0 }] });
    await expect(client.query("SELECT count(*)::int AS count FROM audit_events WHERE request_id = $1", [fixture.requestId])).resolves.toMatchObject({ rows: [{ count: 0 }] });
  });

  it("commits one terminal projection when completion and recovery race", async () => {
    const client = requirePool();
    const fixture = await seedClaimedProjectionFixture("terminal_recovery_race", new Date(Date.now() + 60_000).toISOString());
    const repository = new DbDeploymentCommandRepository(requireDb());
    await expect(repository.projectRunning(fixture.commandId, fixture.agentId, runningProjection(fixture))).resolves.toMatchObject({ applied: true, command: { state: "executing" } });

    const projection = terminalProjection(fixture);
    const completion = repository.transitionTerminalAndProject(
      fixture.commandId,
      fixture.agentId,
      "executing",
      { state: "completed", completedAt: fixture.now, leaseExpiresAt: null, failureReason: null, payload: {} },
      projection,
      { leaseExpiresAtAfterNow: () => new Date().toISOString() }
    );
    const recovery = repository.projectTerminal(fixture.commandId, fixture.agentId, "completed", projection);
    const results = await Promise.all([completion, recovery]);

    expect(results.filter((result) => result?.applied)).toHaveLength(1);
    await expect(repository.findById(fixture.commandId)).resolves.toMatchObject({ state: "completed" });
    await expect(client.query("SELECT status FROM deployments WHERE id = $1", [fixture.deploymentId])).resolves.toMatchObject({ rows: [{ status: "succeeded" }] });
    await expect(client.query("SELECT count(*)::int AS count FROM deployment_logs WHERE deployment_id = $1", [fixture.deploymentId])).resolves.toMatchObject({ rows: [{ count: 2 }] });
    await expect(client.query("SELECT count(*)::int AS count FROM audit_events WHERE request_id = $1", [fixture.requestId])).resolves.toMatchObject({ rows: [{ count: 2 }] });
  });
});

async function seedClaimedProjectionFixture(label: string, leaseExpiresAt: string) {
  const client = requirePool();
  const agentId = randomUUID();
  const projectId = randomUUID();
  const deploymentId = randomUUID();
  const commandId = randomUUID();
  const requestId = `req_projection_${label}`;
  const correlationId = `corr_projection_${label}`;
  const now = new Date().toISOString();
  await client.query("INSERT INTO agents (id, name, endpoint, status) VALUES ($1, $2, $3, 'online')", [agentId, `Agent ${label}`, `https://${label}.agent.test`]);
  await client.query("INSERT INTO projects (id, name, repo_url, default_branch, port) VALUES ($1, $2, $3, 'main', 3000)", [projectId, `Project ${label}`, `https://github.com/example/${label}`]);
  await client.query("INSERT INTO deployments (id, project_id, agent_id, status, commit_sha, started_at) VALUES ($1, $2, $3, 'queued', 'abcdef1', $4)", [deploymentId, projectId, agentId, now]);
  await client.query("INSERT INTO deployment_commands (id, deployment_id, agent_id, kind, state, payload, request_id, correlation_id, issued_at, claimed_at, lease_expires_at) VALUES ($1, $2, $3, 'start', 'claimed', '{}'::jsonb, $4, $5, $6, $6, $7)", [commandId, deploymentId, agentId, requestId, correlationId, now, leaseExpiresAt]);
  return { agentId, projectId, deploymentId, commandId, requestId, correlationId, now };
}

function runningProjection(fixture: Awaited<ReturnType<typeof seedClaimedProjectionFixture>>, actorUserId: string | null = null) {
  return {
    deployment: { id: fixture.deploymentId, projectId: fixture.projectId, agentId: fixture.agentId, status: "running" as const, commitSha: "abcdef1", startedAt: fixture.now, finishedAt: null },
    log: { id: randomUUID(), deploymentId: fixture.deploymentId, level: "info" as const, message: "running token dl_1234567890abcdef", timestamp: fixture.now, redactionApplied: false, requestId: fixture.requestId, correlationId: fixture.correlationId },
    audit: { actorUserId, action: "deployment.running", targetType: "deployment", targetId: fixture.deploymentId, requestId: fixture.requestId, correlationId: fixture.correlationId, metadata: { token: "dl_1234567890abcdef" } }
  };
}

function terminalProjection(fixture: Awaited<ReturnType<typeof seedClaimedProjectionFixture>>) {
  return {
    deployment: { id: fixture.deploymentId, projectId: fixture.projectId, agentId: fixture.agentId, status: "succeeded" as const, commitSha: "abcdef1", startedAt: fixture.now, finishedAt: fixture.now },
    log: { id: randomUUID(), deploymentId: fixture.deploymentId, level: "info" as const, message: "Agent completed deployment command; deployment succeeded.", timestamp: fixture.now, redactionApplied: true, requestId: fixture.requestId, correlationId: fixture.correlationId },
    audit: { actorUserId: null, action: "deployment.completed", targetType: "deployment", targetId: fixture.deploymentId, requestId: fixture.requestId, correlationId: fixture.correlationId, metadata: { source: "agent" } }
  };
}

function requirePool(): pg.Pool {
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

function requireDbRoleRepository(): DbRoleRepository {
  return new DbRoleRepository(requireDb());
}

function requireDbAuthUserRepository(): DbAuthUserRepository {
  return new DbAuthUserRepository(requireDb());
}

function requireDbSessionRepository(): DbSessionRepository {
  return new DbSessionRepository(requireDb());
}

function requireDbAgentRepository(): DbAgentRepository {
  return new DbAgentRepository(requireDb());
}

function requireDbProjectRepository(): DbProjectRepository {
  return new DbProjectRepository(requireDb());
}

function requireDbDeploymentRepository(): DbDeploymentRepository {
  return new DbDeploymentRepository(requireDb());
}

async function applyMigrations(connectionString: string): Promise<void> {
  const migrationClient = new Client({ connectionString });
  await migrationClient.connect();

  try {
    const migrationsUrl = new URL("../migrations/", import.meta.url);
    const migrationFiles = (await readdir(migrationsUrl)).filter((file) => file.endsWith(".sql")).sort();

    for (const file of migrationFiles) {
      const sql = await readFile(new URL(file, migrationsUrl), "utf8");
      await migrationClient.query(sql);
    }
  } finally {
    await migrationClient.end();
  }
}

function quoteIdentifier(identifier: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(identifier)) {
    throw new Error(`Unsafe PostgreSQL identifier: ${identifier}`);
  }

  return `"${identifier}"`;
}

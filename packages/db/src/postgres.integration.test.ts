import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDbClient, createDbPool, closeDbPool, type DeployLiteDb } from "./client.js";
import { assertEnvMetadataHasNoValueColumns, toEnvVariableMetadataInsert } from "./env-metadata.js";
import { DbAuditRepository, DbAuthUserRepository, DbRoleRepository, DbSessionRepository } from "./repositories/auth.js";
import { DbDeploymentCommandRepository } from "./repositories/deployment-commands.js";
import { DbAgentRepository, DbDeploymentRepository, DbProjectRepository } from "./repositories/deployment-data.js";

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

  it("matches the mock audit adapter by returning one redacted event for concurrent retries", async () => {
    const audit = new DbAuditRepository(requireDb());
    const id = randomUUID();
    const input = {
      action: "deployment.cancel",
      targetType: "deployment",
      targetId: "deployment-integration",
      requestId: "req_audit_once",
      correlationId: "corr_audit_once",
      metadata: { authorization: "Bearer dl_1234567890", safe: "visible" }
    };

    const events = await Promise.all(Array.from({ length: 16 }, () => audit.appendOnce(input, id)));
    const page = await audit.list({ action: input.action });
    const stored = await requirePool().query<{ metadata: Record<string, unknown> }>("SELECT metadata FROM audit_events WHERE id = $1", [id]);

    expect(events).toEqual(Array.from({ length: 16 }, () => events[0]));
    expect(page.events.filter((event) => event.id === id)).toHaveLength(1);
    expect(stored.rows).toEqual([{ metadata: { authorization: "[REDACTED]", safe: "visible" } }]);
    await expect(audit.appendOnce({ ...input, action: "ignored.retry" }, id)).resolves.toEqual(events[0]);
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

  it("keeps terminal deployment, command, and log projections atomic when cancellation interleaves", async () => {
    const cancelled = await createClaimedDeploymentCommand();
    const lockClient = new Client({ connectionString: databaseUrl });
    const cancellationPool = createDbPool(databaseUrl, { max: 1 });
    const cancellationCommands = new DbDeploymentCommandRepository(createDbClient(cancellationPool));
    await lockClient.connect();
    await lockClient.query("BEGIN");
    await lockClient.query("SELECT 1 FROM deployments WHERE id = $1 FOR UPDATE", [cancelled.deployment.id]);

    try {
      const terminal = requireDbDeploymentCommandRepository().projectTerminal(
        cancelled.command.id,
        cancelled.command.agentId,
        "completed",
        { ...cancelled.deployment, status: "succeeded", finishedAt: new Date().toISOString() },
        "running",
        terminalLog(cancelled.deployment.id, "terminal token dl_1234567890 must not persist"),
        requireDbDeploymentRepository()
      );
      await waitForDeploymentUpdateToBlock();

      const cancelledCommand = await cancellationCommands.transitionTerminal(
        cancelled.command.id,
        cancelled.command.agentId,
        "claimed",
        { state: "cancelled", completedAt: new Date().toISOString(), leaseExpiresAt: null, failureReason: null, payload: cancelled.command.payload }
      );
      expect(cancelledCommand).toMatchObject({ applied: true, command: { state: "cancelled" } });

      await lockClient.query("COMMIT");
      const result = await terminal;
      expect(result).toMatchObject({ applied: false, command: { id: cancelled.command.id, state: "cancelled" } });
    } finally {
      await lockClient.query("ROLLBACK").catch(() => undefined);
      await lockClient.end();
      await closeDbPool(cancellationPool);
    }

    await expect(requireDbDeploymentRepository().findById(cancelled.deployment.id)).resolves.toMatchObject({ status: "running", finishedAt: null });
    await expect(requireDbDeploymentRepository().listLogs(cancelled.deployment.id)).resolves.toEqual([]);
    await expect(requireDbDeploymentCommandRepository().findById(cancelled.command.id)).resolves.toMatchObject({ state: "cancelled" });

    const completed = await createClaimedDeploymentCommand();
    const result = await requireDbDeploymentCommandRepository().projectTerminal(
      completed.command.id,
      completed.command.agentId,
      "completed",
      { ...completed.deployment, status: "succeeded", finishedAt: new Date().toISOString() },
      "running",
      terminalLog(completed.deployment.id, "terminal token dl_1234567890 must be redacted"),
      requireDbDeploymentRepository()
    );

    expect(result).toMatchObject({ applied: true, command: { id: completed.command.id, state: "completed" } });
    await expect(requireDbDeploymentRepository().findById(completed.deployment.id)).resolves.toMatchObject({ status: "succeeded" });
    await expect(requireDbDeploymentRepository().listLogs(completed.deployment.id)).resolves.toEqual([
      expect.objectContaining({ deploymentId: completed.deployment.id, sequence: 1, message: expect.stringContaining("[REDACTED]"), redactionApplied: true })
    ]);
  }, 30_000);

  it("rejects expired claimed terminal projections without changing the deployment or logs", async () => {
    const expired = await createClaimedDeploymentCommand(new Date("2000-01-01T00:00:00.000Z"));

    await expect(requireDbDeploymentCommandRepository().projectTerminal(
      expired.command.id,
      expired.command.agentId,
      "completed",
      { ...expired.deployment, status: "succeeded", finishedAt: new Date().toISOString() },
      "running",
      terminalLog(expired.deployment.id, "expired lease must not project"),
      requireDbDeploymentRepository()
    )).resolves.toMatchObject({ applied: false, command: { id: expired.command.id, state: "claimed" } });
    await expect(requireDbDeploymentRepository().findById(expired.deployment.id)).resolves.toEqual(expired.deployment);
    await expect(requireDbDeploymentRepository().listLogs(expired.deployment.id)).resolves.toEqual([]);
  });

  it("rejects a claimed terminal projection when its lease equals the authoritative database clock", async () => {
    const controlledClock = "2042-02-03T04:05:06.000Z";
    const boundary = await createClaimedDeploymentCommand(new Date(controlledClock));
    const client = requirePool();

    await client.query("CREATE SCHEMA terminal_projection_clock");
    await client.query(`CREATE FUNCTION terminal_projection_clock.clock_timestamp() RETURNS timestamptz LANGUAGE SQL IMMUTABLE AS $$ SELECT TIMESTAMPTZ '${controlledClock}' $$`);
    await client.query("SET search_path TO terminal_projection_clock, public, pg_catalog");

    try {
      await expect(client.query<{ clock: Date }>("SELECT clock_timestamp() AS clock")).resolves.toMatchObject({
        rows: [{ clock: new Date(controlledClock) }]
      });
      await client.query("UPDATE deployment_commands SET lease_expires_at = clock_timestamp() WHERE id = $1", [boundary.command.id]);

      await expect(requireDbDeploymentCommandRepository().projectTerminal(
        boundary.command.id,
        boundary.command.agentId,
        "completed",
        { ...boundary.deployment, status: "succeeded", finishedAt: new Date().toISOString() },
        "running",
        terminalLog(boundary.deployment.id, "equal lease must not project"),
        requireDbDeploymentRepository()
      )).resolves.toMatchObject({ applied: false, command: { id: boundary.command.id, state: "claimed" } });
    } finally {
      await client.query("RESET search_path");
      await client.query("DROP SCHEMA terminal_projection_clock CASCADE");
    }

    await expect(requireDbDeploymentRepository().findById(boundary.deployment.id)).resolves.toEqual(boundary.deployment);
    await expect(requireDbDeploymentRepository().listLogs(boundary.deployment.id)).resolves.toEqual([]);
  });

  it("allocates terminal and restarted executor logs after explicit sequences without collisions", async () => {
    const terminal = await createClaimedDeploymentCommand();
    const deployments = requireDbDeploymentRepository();
    await deployments.appendLog({
      ...terminalLog(terminal.deployment.id, "explicit token dl_1234567890 must be redacted"), sequence: 41
    });

    await expect(requireDbDeploymentCommandRepository().projectTerminal(
      terminal.command.id, terminal.command.agentId, "completed",
      { ...terminal.deployment, status: "succeeded", finishedAt: new Date().toISOString() }, "running",
      terminalLog(terminal.deployment.id, "terminal token dl_1234567890 must be redacted"), deployments
    )).resolves.toMatchObject({ applied: true, command: { state: "completed" } });

    const restarted = await Promise.all(Array.from({ length: 16 }, (_, index) => deployments.appendAllocatedLog({
      ...terminalLog(terminal.deployment.id, `restart ${index}`), id: randomUUID()
    })));
    expect(restarted.map((event) => event.sequence).sort((left, right) => left - right)).toEqual(Array.from({ length: 16 }, (_, index) => index + 43));
    await expect(deployments.listLogs(terminal.deployment.id)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ sequence: 41, message: expect.stringContaining("[REDACTED]") }),
      expect.objectContaining({ sequence: 42, message: expect.stringContaining("[REDACTED]") })
    ]));
  }, 30_000);
});

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

function requireDbDeploymentCommandRepository(): DbDeploymentCommandRepository {
  return new DbDeploymentCommandRepository(requireDb());
}

async function createClaimedDeploymentCommand(leaseExpiresAt = new Date(Date.now() + 60_000)): Promise<{
  deployment: { id: string; projectId: string; agentId: string; status: "running"; commitSha: string; startedAt: string; finishedAt: null };
  command: Awaited<ReturnType<DbDeploymentCommandRepository["save"]>>;
}> {
  const projectId = randomUUID();
  const agentId = randomUUID();
  const deploymentId = randomUUID();
  const commandId = randomUUID();
  const now = new Date().toISOString();
  const deployment = { id: deploymentId, projectId, agentId, status: "running" as const, commitSha: "abcdef1234567890", startedAt: now, finishedAt: null };

  await requireDbProjectRepository().save({
    id: projectId,
    name: "Terminal projection project",
    repoUrl: "https://github.com/example/terminal-projection",
    defaultBranch: "main",
    buildCommand: null,
    runCommand: "node server.js",
    port: 3000,
    description: null,
    imageTag: null
  });
  await requireDbAgentRepository().save({ id: agentId, name: "Terminal projection agent", endpoint: "https://agent.terminal.test", status: "online", lastHeartbeatAt: now, resourceSnapshot: null });
  await requireDbDeploymentRepository().save(deployment);
  const command = await requireDbDeploymentCommandRepository().save({
    id: commandId,
    deploymentId,
    agentId,
    kind: "start",
    state: "claimed",
    payload: {},
    requestedBy: null,
    requestId: `req_${commandId}`,
    correlationId: `corr_${commandId}`,
    issuedAt: now,
    claimedAt: now,
    leaseExpiresAt: leaseExpiresAt.toISOString(),
    completedAt: null,
    failureReason: null
  });
  return { deployment, command };
}

function terminalLog(deploymentId: string, message: string) {
  return {
    id: randomUUID(),
    deploymentId,
    level: "info" as const,
    message,
    timestamp: new Date().toISOString(),
    redactionApplied: false,
    requestId: "req_terminal_projection",
    correlationId: "corr_terminal_projection"
  };
}

async function waitForDeploymentUpdateToBlock(): Promise<void> {
  const observer = new Client({ connectionString: databaseUrl });
  await observer.connect();
  try {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const result = await observer.query<{ waiting: boolean }>(
        "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%update \"deployments\"%') AS waiting"
      );
      if (result.rows[0]?.waiting) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("Terminal projection did not block on the deployment lock");
  } finally {
    await observer.end();
  }
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

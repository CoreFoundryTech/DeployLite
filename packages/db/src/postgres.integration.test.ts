import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDbClient, createDbPool, closeDbPool, type DeployLiteDb } from "./client.js";
import { assertEnvMetadataHasNoValueColumns, toEnvVariableMetadataInsert } from "./env-metadata.js";
import { DbAuthUserRepository, DbRoleRepository, DbSessionRepository } from "./repositories/auth.js";
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
      port: 3000
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
    await expect(requireDbProjectRepository().list()).resolves.toContainEqual({
      id: projectId,
      name: "Integration project",
      repoUrl: "https://github.com/example/deploylite-integration",
      defaultBranch: "main"
    });
    await expect(requireDbDeploymentRepository().findById(deploymentId)).resolves.toMatchObject({
      id: deploymentId,
      projectId,
      agentId,
      status: "running",
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

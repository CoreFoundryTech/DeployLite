import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const migrationsDir = join(packageRoot, "migrations");
const schemaPath = join(packageRoot, "src", "schema.ts");
const canonicalRoles = ["admin", "operator", "read-only", "auditor"];
const forbiddenEnvValueColumns = ["value", "secret", "encrypted_value"];

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", ...options });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`${command} ${args.join(" ")} exited with code ${code ?? "unknown"}`));
    });
  });
}

function tableBody(sql, tableName) {
  const match = sql.match(new RegExp(`CREATE TABLE ${tableName} \\(([\\s\\S]*?)\\n\\);`, "i"));
  assert(match, `Migration must create ${tableName}`);
  return match[1];
}

function assertCanonicalRoles(sql, schemaSource) {
  for (const role of canonicalRoles) {
    assert(schemaSource.includes(`"${role}"`), `Schema must export canonical role ${role}`);
    assert(sql.includes(`'${role}'`), `Migration must seed canonical role ${role}`);
  }

  assert(!schemaSource.includes('"owner"'), "Schema must not export non-canonical owner role");
  assert(!schemaSource.includes('"viewer"'), "Schema must not export non-canonical viewer role");
  assert(sql.includes("CONSTRAINT roles_name_canonical"), "Migration must DB-enforce canonical role names");
  assert(sql.includes("role_id uuid NOT NULL REFERENCES roles(id)"), "users.role_id must be a required FK to roles");
  assert(sql.includes("CREATE INDEX users_role_id_idx ON users (role_id)"), "users.role_id must have an explicit FK index");
}

function assertEnvMetadataBoundary(sql) {
  const body = tableBody(sql, "env_variable_metadata");

  for (const column of forbiddenEnvValueColumns) {
    assert(!new RegExp(`\\n\\s*${column}\\s+text\\b`, "i").test(body), `env_variable_metadata must not persist ${column} text`);
  }

  assert(body.includes("value_present boolean NOT NULL DEFAULT false"), "env_variable_metadata must keep value_present metadata only");
  assert(sql.includes("CREATE INDEX env_variable_metadata_project_id_idx ON env_variable_metadata (project_id)"), "env metadata FK access path must be indexed");
}

function assertRequiredFoundation(sql) {
  const requiredTables = [
    "roles",
    "users",
    "user_sessions",
    "audit_events",
    "servers",
    "agents",
    "projects",
    "deployments",
    "deployment_logs",
    "env_variable_metadata",
    "domains",
    "certificates",
    "deployment_commands"
  ];

  for (const table of requiredTables) {
    assert(sql.includes(`CREATE TABLE ${table}`), `Migration must create ${table}`);
  }

  const requiredFragments = [
    "CONSTRAINT users_status_valid CHECK (status IN ('active', 'disabled'))",
    "CREATE UNIQUE INDEX user_sessions_token_hash_unique ON user_sessions (token_hash)",
    "CREATE INDEX user_sessions_user_id_idx ON user_sessions (user_id)",
    "CREATE INDEX deployments_project_id_idx ON deployments (project_id)",
    "CREATE INDEX audit_events_actor_user_id_idx ON audit_events (actor_user_id)",
    "CREATE INDEX certificates_domain_id_idx ON certificates (domain_id)",
    "CONSTRAINT deployment_commands_kind_valid CHECK (kind IN ('start', 'cancel', 'restart', 'rollback'))",
    "CONSTRAINT deployment_commands_state_valid CHECK (state IN ('pending', 'claimed', 'executing', 'completed', 'cancelled', 'failed'))",
    "CREATE INDEX deployment_commands_state_idx ON deployment_commands (state)",
    "CREATE INDEX deployment_commands_agent_id_idx ON deployment_commands (agent_id)"
  ];

  for (const fragment of requiredFragments) {
    assert(sql.includes(fragment), `Migration missing required fragment: ${fragment}`);
  }
}

async function main() {
  const migrationFiles = (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();
  assert(migrationFiles.length > 0, "At least one hand-authored SQL migration is required");

  const migrationSql = (await Promise.all(migrationFiles.map((file) => readFile(join(migrationsDir, file), "utf8")))).join("\n");
  const schemaSource = await readFile(schemaPath, "utf8");

  assertCanonicalRoles(migrationSql, schemaSource);
  assertEnvMetadataBoundary(migrationSql);
  assertRequiredFoundation(migrationSql);

  await run("tsc", ["-p", "tsconfig.json", "--noEmit"], { cwd: packageRoot });

  console.log(`Validated ${migrationFiles.length} SQL migration file(s) and TypeScript schema exports.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

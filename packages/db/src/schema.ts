import { sql } from "drizzle-orm";
import { boolean, check, customType, index, integer, jsonb, pgTable, smallint, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

const bytea = customType<{ data: Buffer; notNull: false; default: false }>({
  dataType() {
    return "bytea";
  }
});

export const canonicalRoleNames = ["admin", "operator", "read-only", "auditor"] as const;
export type CanonicalRoleName = (typeof canonicalRoleNames)[number];

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
};

const jsonObject = <Name extends string>(name: Name) => jsonb(name).$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`);

export const roles = pgTable(
  "roles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    description: text("description").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    uniqueIndex("roles_name_unique").on(table.name),
    check("roles_name_canonical", sql`${table.name} in ('admin', 'operator', 'read-only', 'auditor')`)
  ]
);

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    emailNormalized: text("email_normalized").notNull(),
    passwordHash: text("password_hash").notNull(),
    roleId: uuid("role_id").notNull().references(() => roles.id, { onDelete: "restrict", onUpdate: "cascade" }),
    status: text("status").notNull().default("active"),
    ...timestamps
  },
  (table) => [
    uniqueIndex("users_email_normalized_unique").on(table.emailNormalized),
    index("users_role_id_idx").on(table.roleId),
    check("users_status_valid", sql`${table.status} in ('active', 'disabled')`),
    check("users_email_normalized_lower", sql`${table.emailNormalized} = lower(${table.emailNormalized})`)
  ]
);

export const userSessions = pgTable(
  "user_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade", onUpdate: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    ipHash: text("ip_hash"),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
  },
  (table) => [
    uniqueIndex("user_sessions_token_hash_unique").on(table.tokenHash),
    index("user_sessions_user_id_idx").on(table.userId),
    index("user_sessions_expires_at_idx").on(table.expiresAt)
  ]
);

export const apiKeys = pgTable(
  "api_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade", onUpdate: "cascade" }),
    name: text("name").notNull(),
    keyPrefix: text("key_prefix").notNull(),
    keyHash: text("key_hash").notNull(),
    status: text("status").notNull().default("active"),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    ...timestamps
  },
  (table) => [
    uniqueIndex("api_keys_key_hash_unique").on(table.keyHash),
    index("api_keys_user_id_idx").on(table.userId),
    check("api_keys_status_valid", sql`${table.status} in ('active', 'revoked')`)
  ]
);

export const servers = pgTable(
  "servers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    endpoint: text("endpoint").notNull(),
    status: text("status").notNull().default("offline"),
    metadata: jsonObject("metadata"),
    ...timestamps
  },
  (table) => [check("servers_status_valid", sql`${table.status} in ('online', 'offline', 'stale', 'disabled')`)]
);

export const agents = pgTable(
  "agents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    serverId: uuid("server_id").references(() => servers.id, { onDelete: "set null", onUpdate: "cascade" }),
    name: text("name").notNull(),
    endpoint: text("endpoint").notNull(),
    status: text("status").notNull().default("offline"),
    lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }),
    resourceSnapshot: jsonb("resource_snapshot").$type<Record<string, unknown> | null>(),
    ...timestamps
  },
  (table) => [
    index("agents_server_id_idx").on(table.serverId),
    check("agents_status_valid", sql`${table.status} in ('online', 'offline', 'stale', 'disabled')`)
  ]
);

export const projects = pgTable("projects", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  repoUrl: text("repo_url").notNull(),
  defaultBranch: text("default_branch").notNull(),
  buildCommand: text("build_command"),
  runCommand: text("run_command"),
  port: integer("port"),
  description: text("description"),
  imageTag: text("image_tag"),
  ...timestamps
});

export const deployments = pgTable(
  "deployments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "restrict", onUpdate: "cascade" }),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null", onUpdate: "cascade" }),
    status: text("status").notNull().default("queued"),
    commitSha: text("commit_sha").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    metadata: jsonObject("metadata"),
    ...timestamps
  },
  (table) => [
    index("deployments_project_id_idx").on(table.projectId),
    index("deployments_agent_id_idx").on(table.agentId),
    check("deployments_status_valid", sql`${table.status} in ('queued', 'running', 'succeeded', 'failed', 'canceled')`)
  ]
);

export const deploymentLogs = pgTable(
  "deployment_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    deploymentId: uuid("deployment_id").notNull().references(() => deployments.id, { onDelete: "cascade", onUpdate: "cascade" }),
    sequence: integer("sequence").notNull(),
    level: text("level").notNull(),
    message: text("message").notNull(),
    redactionApplied: boolean("redaction_applied").notNull().default(true),
    requestId: text("request_id").notNull(),
    correlationId: text("correlation_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    uniqueIndex("deployment_logs_deployment_sequence_unique").on(table.deploymentId, table.sequence),
    index("deployment_logs_deployment_id_idx").on(table.deploymentId),
    check("deployment_logs_level_valid", sql`${table.level} in ('debug', 'info', 'warn', 'error')`)
  ]
);

export const auditEvents = pgTable(
  "audit_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null", onUpdate: "cascade" }),
    action: text("action").notNull(),
    targetType: text("target_type").notNull(),
    targetId: text("target_id").notNull(),
    requestId: text("request_id").notNull(),
    correlationId: text("correlation_id").notNull(),
    metadata: jsonObject("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    index("audit_events_actor_user_id_idx").on(table.actorUserId),
    index("audit_events_created_at_idx").on(table.createdAt),
    index("audit_events_target_idx").on(table.targetType, table.targetId)
  ]
);

export const envVariableMetadata = pgTable(
  "env_variable_metadata",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade", onUpdate: "cascade" }),
    key: text("key").notNull(),
    scope: text("scope").notNull().default("project"),
    valuePresent: boolean("value_present").notNull().default(false),
    valueFingerprint: text("value_fingerprint"),
    required: boolean("required").notNull().default(false),
    description: text("description"),
    metadata: jsonObject("metadata"),
    ...timestamps
  },
  (table) => [
    uniqueIndex("env_variable_metadata_project_key_scope_unique").on(table.projectId, table.key, table.scope),
    index("env_variable_metadata_project_id_idx").on(table.projectId),
    check("env_variable_metadata_scope_valid", sql`${table.scope} in ('project', 'deployment')`)
  ]
);

export const envSecretValues = pgTable(
  "env_secret_values",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade", onUpdate: "cascade" }),
    key: text("key").notNull(),
    scope: text("scope").notNull().default("project"),
    encryptedValue: bytea("encrypted_value").notNull(),
    valueFingerprint: text("value_fingerprint").notNull(),
    keyVersion: smallint("key_version").notNull().default(1),
    ...timestamps
  },
  (table) => [
    uniqueIndex("env_secret_values_project_key_scope_unique").on(table.projectId, table.key, table.scope),
    index("env_secret_values_project_id_idx").on(table.projectId),
    check("env_secret_values_scope_valid", sql`${table.scope} in ('project', 'deployment')`),
    check(
      "env_secret_values_key_fingerprint_not_blank",
      sql`length(btrim(${table.valueFingerprint})) > 0`
    ),
    check("env_secret_values_key_version_positive", sql`${table.keyVersion} > 0`)
  ]
);

// =====================================================================
// Deployment command queue.
//
// Persistent control-plane queue for deployment intent. The API submits
// commands (`start`, `cancel`, `restart`, `rollback`) here; the
// deployment agent (or a mock executor) claims them, drives the
// lifecycle, and resolves them through the same table. The state
// machine mirrors the in-process port in `packages/domain`:
//
//   pending  -> claimed   -> completed
//                        -> failed
//           -> cancelled
//   claimed  -> cancelled (handled by the executor mid-flight)
//
// The table is intentionally narrow: it is a control-plane record, not
// an audit log. Per-row correlation IDs ride along so the API can
// stitch the command back to the originating HTTP request and the
// agent can fan logs out under the same correlation id. No secret
// values are stored here; the `payload` JSONB is the safe command
// arguments (commit SHA, requested actor, restart-from-deployment id,
// etc.) and must remain free of any plaintext material.
// =====================================================================

export const deploymentCommands = pgTable(
  "deployment_commands",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    deploymentId: uuid("deployment_id").notNull().references(() => deployments.id, { onDelete: "cascade", onUpdate: "cascade" }),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "restrict", onUpdate: "cascade" }),
    kind: text("kind").notNull(),
    state: text("state").notNull().default("pending"),
    payload: jsonObject("payload"),
    requestedBy: uuid("requested_by").references(() => users.id, { onDelete: "set null", onUpdate: "cascade" }),
    requestId: text("request_id").notNull(),
    correlationId: text("correlation_id").notNull(),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull().defaultNow(),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    failureReason: text("failure_reason"),
    ...timestamps
  },
  (table) => [
    index("deployment_commands_deployment_id_idx").on(table.deploymentId),
    index("deployment_commands_agent_id_idx").on(table.agentId),
    index("deployment_commands_state_idx").on(table.state),
    index("deployment_commands_issued_at_idx").on(table.issuedAt),
    check("deployment_commands_kind_valid", sql`${table.kind} in ('start', 'cancel', 'restart', 'rollback')`),
    check("deployment_commands_state_valid", sql`${table.state} in ('pending', 'claimed', 'completed', 'cancelled', 'failed')`),
    check(
      "deployment_commands_terminal_state_has_completed_at",
      sql`(${table.state} in ('completed', 'cancelled', 'failed')) = (${table.completedAt} is not null)`
    ),
    check(
      "deployment_commands_failure_reason_only_on_failed",
      sql`(${table.state} = 'failed') = (${table.failureReason} is not null)`
    )
  ]
);

export const domains = pgTable(
  "domains",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade", onUpdate: "cascade" }),
    hostname: text("hostname").notNull(),
    status: text("status").notNull().default("pending"),
    metadata: jsonObject("metadata"),
    ...timestamps
  },
  (table) => [
    uniqueIndex("domains_hostname_unique").on(table.hostname),
    index("domains_project_id_idx").on(table.projectId),
    check("domains_status_valid", sql`${table.status} in ('pending', 'active', 'failed', 'disabled')`)
  ]
);

export const certificates = pgTable(
  "certificates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    domainId: uuid("domain_id").notNull().references(() => domains.id, { onDelete: "cascade", onUpdate: "cascade" }),
    provider: text("provider").notNull().default("acme-metadata-only"),
    status: text("status").notNull().default("pending"),
    notBefore: timestamp("not_before", { withTimezone: true }),
    notAfter: timestamp("not_after", { withTimezone: true }),
    metadata: jsonObject("metadata"),
    ...timestamps
  },
  (table) => [
    index("certificates_domain_id_idx").on(table.domainId),
    check("certificates_status_valid", sql`${table.status} in ('pending', 'issued', 'expired', 'revoked', 'failed')`)
  ]
);

export type Role = typeof roles.$inferSelect;
export type NewRole = typeof roles.$inferInsert;
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type UserSession = typeof userSessions.$inferSelect;
export type NewUserSession = typeof userSessions.$inferInsert;
export type AuditEventRow = typeof auditEvents.$inferSelect;
export type NewAuditEvent = typeof auditEvents.$inferInsert;
export type Server = typeof servers.$inferSelect;
export type NewServer = typeof servers.$inferInsert;
export type AgentRow = typeof agents.$inferSelect;
export type NewAgentRow = typeof agents.$inferInsert;
export type ProjectRow = typeof projects.$inferSelect;
export type NewProjectRow = typeof projects.$inferInsert;
export type DeploymentRow = typeof deployments.$inferSelect;
export type NewDeploymentRow = typeof deployments.$inferInsert;
export type DeploymentLogRow = typeof deploymentLogs.$inferSelect;
export type NewDeploymentLogRow = typeof deploymentLogs.$inferInsert;
export type NewEnvVariableMetadata = typeof envVariableMetadata.$inferInsert;
export type EnvSecretValueRow = typeof envSecretValues.$inferSelect;
export type NewEnvSecretValue = typeof envSecretValues.$inferInsert;
export type DeploymentCommandRow = typeof deploymentCommands.$inferSelect;
export type NewDeploymentCommandRow = typeof deploymentCommands.$inferInsert;

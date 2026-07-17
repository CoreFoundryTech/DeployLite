import { z } from "zod";

export const idSchema = z.string().min(1);
export const isoDateSchema = z.string().datetime({ offset: true });
export const requestContextSchema = z.object({
  requestId: idSchema,
  correlationId: idSchema
});

export const errorEnvelopeSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  correlationId: idSchema
});

export const responseEnvelopeSchema = <Data extends z.ZodTypeAny>(data: Data) =>
  z.object({
    data: data.nullable(),
    error: errorEnvelopeSchema.nullable(),
    requestId: idSchema
  });

export const authLoginRequestSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1)
});

export const bootstrapStatusSchema = z.object({
  setupRequired: z.boolean()
});

export const bootstrapInitialAdminRequestSchema = z.object({
  email: z.string().email(),
  password: z.string().min(12)
});

export const canonicalRoleSchema = z.enum(["admin", "operator", "read-only", "auditor"]);

export const safeAuthUserSchema = z.object({
  id: idSchema,
  email: z.string().email(),
  role: canonicalRoleSchema,
  status: z.enum(["active", "disabled"])
});

export const authResponseSchema = z.object({
  user: safeAuthUserSchema
});

export const scaffoldUserSchema = safeAuthUserSchema;

export const resourceSnapshotSchema = z.object({
  cpuLoad: z.number().min(0).max(1),
  memoryUsedBytes: z.number().int().nonnegative(),
  memoryTotalBytes: z.number().int().positive(),
  diskUsedBytes: z.number().int().nonnegative(),
  diskTotalBytes: z.number().int().positive()
});

export const agentStatusSchema = z.enum(["online", "offline", "stale"]);

export const agentRegistrationSchema = z.object({
  name: z.string().min(1),
  endpoint: z.string().url()
});

export const agentHeartbeatSchema = requestContextSchema.extend({
  agentId: idSchema,
  observedAt: isoDateSchema,
  resourceSnapshot: resourceSnapshotSchema
});

export const agentSchema = z.object({
  id: idSchema,
  name: z.string().min(1),
  endpoint: z.string().url(),
  status: agentStatusSchema,
  lastHeartbeatAt: isoDateSchema.nullable(),
  resourceSnapshot: resourceSnapshotSchema.nullable()
});

export const projectSchema = z.object({
  id: idSchema,
  name: z.string().min(1),
  repoUrl: z.string().url(),
  defaultBranch: z.string().min(1),
  buildCommand: z.string().min(1).nullable(),
  runCommand: z.string().min(1).nullable(),
  port: z.number().int().min(1).max(65535).nullable(),
  description: z.string().max(2000).nullable(),
  imageTag: z.string().min(1).max(256).nullable()
});

export const projectCreateRequestSchema = z.object({
  name: z.string().min(1),
  repoUrl: z.string().url(),
  defaultBranch: z.string().min(1),
  buildCommand: z.string().min(1).optional(),
  runCommand: z.string().min(1).optional(),
  port: z.coerce.number().int().min(1).max(65535).optional(),
  description: z.string().max(2000).nullable().optional(),
  imageTag: z.string().min(1).max(256).nullable().optional()
});

const nullableRuntimeStringSchema = z.string().min(1).nullable();
const nullablePortSchema = z.union([z.coerce.number().int().min(1).max(65535), z.null()]);
const nullableDescriptionSchema = z.union([z.string().max(2000), z.null()]);
const nullableImageTagSchema = z.union([z.string().min(1).max(256), z.null()]);

export const projectUpdateRequestSchema = z.object({
  name: z.string().min(1).optional(),
  repoUrl: z.string().url().optional(),
  defaultBranch: z.string().min(1).optional(),
  buildCommand: nullableRuntimeStringSchema.optional(),
  runCommand: nullableRuntimeStringSchema.optional(),
  port: nullablePortSchema.optional(),
  description: nullableDescriptionSchema.optional(),
  imageTag: nullableImageTagSchema.optional()
});

export const envVariableMetadataSchema = z.object({
  id: idSchema,
  projectId: idSchema,
  key: z.string().min(1),
  scope: z.enum(["project", "deployment"]),
  valuePresent: z.boolean(),
  valueFingerprint: z.string().nullable(),
  required: z.boolean(),
  description: z.string().nullable(),
  updatedAt: isoDateSchema
});

export const envVariableMetadataUpsertRequestSchema = z.object({
  key: z.string().min(1).max(128),
  scope: z.enum(["project", "deployment"]).default("project"),
  required: z.boolean().default(false),
  description: z.string().max(512).nullable().optional()
}).strict();

export const envSecretValueWriteRequestSchema = z.object({
  key: z.string().min(1).max(128),
  scope: z.enum(["project", "deployment"]).default("project"),
  value: z.string().min(1).max(8192)
}).strict();

export const envSecretValueSchema = z.object({
  id: idSchema,
  projectId: idSchema,
  key: z.string().min(1),
  scope: z.enum(["project", "deployment"]),
  valuePresent: z.boolean(),
  valueFingerprint: z.string().min(1),
  keyVersion: z.number().int().positive(),
  createdAt: isoDateSchema,
  updatedAt: isoDateSchema
});

export const envSecretValueDeleteRequestSchema = z.object({
  key: z.string().min(1),
  scope: z.enum(["project", "deployment"]).default("project")
}).strict();

const hostnameSchema = z.string().trim().toLowerCase().regex(/^(?=.{1,253}$)(?!-)[a-z0-9-]+(?:\.[a-z0-9-]+)+$/);

// All runtime values are write-only except the public hostname. The ACME
// contact remains operationally sensitive, so reads expose only its marker.
export const runtimeConfigurationWriteRequestSchema = z.object({
  domain: hostnameSchema,
  acmeEmail: z.string().trim().email().max(320),
  databasePassword: z.string().min(16).max(8192),
  runtimeSecret: z.string().min(16).max(8192)
}).strict();

export const runtimeConfigurationSchema = z.object({
  domain: hostnameSchema.nullable(),
  acmeEmailConfigured: z.boolean(),
  databasePasswordConfigured: z.boolean(),
  runtimeSecretConfigured: z.boolean()
});

export const runtimeActivationSchema = z.object({
  id: idSchema,
  status: z.literal("capability_unavailable"),
  capability: z.literal("safe_runtime_executor")
});

export const deployRequestSchema = z.object({
  agentId: idSchema.optional(),
  commitSha: z.string().regex(/^[a-f0-9]{7,40}$/).optional()
});

export const deploymentStatusSchema = z.enum(["queued", "running", "succeeded", "failed", "canceled"]);

export const deploymentSchema = z.object({
  id: idSchema,
  projectId: idSchema,
  agentId: idSchema,
  status: deploymentStatusSchema,
  commitSha: z.string().regex(/^[a-f0-9]{7,40}$/),
  startedAt: isoDateSchema,
  finishedAt: isoDateSchema.nullable()
});

export const logEventSchema = requestContextSchema.extend({
  id: idSchema,
  deploymentId: idSchema,
  sequence: z.number().int().nonnegative(),
  level: z.enum(["debug", "info", "warn", "error"]),
  message: z.string().min(1),
  timestamp: isoDateSchema,
  redactionApplied: z.boolean()
});

export const sseEventSchema = z.object({
  id: z.number().int().nonnegative(),
  event: z.enum(["deployment.log", "deployment.status", "heartbeat.status", "stream.truncated"]),
  data: z.record(z.unknown())
});

export const mcpToolResultSchema = requestContextSchema.extend({
  content: z.array(z.object({ type: z.literal("text"), text: z.string() })),
  structuredContent: z.record(z.unknown())
});

export type AgentHeartbeat = z.infer<typeof agentHeartbeatSchema>;
export type Agent = z.infer<typeof agentSchema>;
export type Deployment = z.infer<typeof deploymentSchema>;
export type LogEvent = z.infer<typeof logEventSchema>;
export type Project = z.infer<typeof projectSchema>;
export type ProjectCreateRequest = z.infer<typeof projectCreateRequestSchema>;
export type ProjectUpdateRequest = z.infer<typeof projectUpdateRequestSchema>;
export type EnvVariableMetadata = z.infer<typeof envVariableMetadataSchema>;
export type EnvVariableMetadataUpsertRequest = z.infer<typeof envVariableMetadataUpsertRequestSchema>;
export type EnvSecretValue = z.infer<typeof envSecretValueSchema>;
export type EnvSecretValueWriteRequest = z.infer<typeof envSecretValueWriteRequestSchema>;
export type EnvSecretValueDeleteRequest = z.infer<typeof envSecretValueDeleteRequestSchema>;
export type RuntimeConfiguration = z.infer<typeof runtimeConfigurationSchema>;
export type RuntimeConfigurationWriteRequest = z.infer<typeof runtimeConfigurationWriteRequestSchema>;
export type RuntimeActivation = z.infer<typeof runtimeActivationSchema>;
export type DeployRequest = z.infer<typeof deployRequestSchema>;
export type ScaffoldUser = z.infer<typeof scaffoldUserSchema>;
export type CanonicalRole = z.infer<typeof canonicalRoleSchema>;
export type SafeAuthUserDto = z.infer<typeof safeAuthUserSchema>;
export type AuthResponse = z.infer<typeof authResponseSchema>;
export type BootstrapStatus = z.infer<typeof bootstrapStatusSchema>;
export type BootstrapInitialAdminRequest = z.infer<typeof bootstrapInitialAdminRequestSchema>;

// Public audit list surface. The metadata column on the audit_events DB row
// stays a free-form JSONB, but the API response strips it so the UI can never
// accidentally render secret keys, fingerprints, or any other sensitive
// detail. The web layer only ever sees this metadata-free shape.
export const auditEventListItemSchema = z.object({
  id: idSchema,
  actorId: z.string().min(1),
  action: z.string().min(1),
  targetType: z.string().min(1),
  targetId: z.string().min(1),
  requestId: idSchema,
  correlationId: idSchema,
  timestamp: isoDateSchema
});

export const auditEventListPageSchema = z.object({
  events: z.array(auditEventListItemSchema),
  total: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative()
});

export type AuditEventListItem = z.infer<typeof auditEventListItemSchema>;
export type AuditEventListPage = z.infer<typeof auditEventListPageSchema>;

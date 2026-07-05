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
  port: z.number().int().min(1).max(65535).nullable()
});

export const projectCreateRequestSchema = z.object({
  name: z.string().min(1),
  repoUrl: z.string().url(),
  defaultBranch: z.string().min(1),
  buildCommand: z.string().min(1).optional(),
  runCommand: z.string().min(1).optional(),
  port: z.coerce.number().int().min(1).max(65535).optional()
});

const nullableRuntimeStringSchema = z.string().min(1).nullable();
const nullablePortSchema = z.union([z.coerce.number().int().min(1).max(65535), z.null()]);

export const projectUpdateRequestSchema = z.object({
  name: z.string().min(1).optional(),
  repoUrl: z.string().url().optional(),
  defaultBranch: z.string().min(1).optional(),
  buildCommand: nullableRuntimeStringSchema.optional(),
  runCommand: nullableRuntimeStringSchema.optional(),
  port: nullablePortSchema.optional()
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
export type DeployRequest = z.infer<typeof deployRequestSchema>;
export type ScaffoldUser = z.infer<typeof scaffoldUserSchema>;
export type CanonicalRole = z.infer<typeof canonicalRoleSchema>;
export type SafeAuthUserDto = z.infer<typeof safeAuthUserSchema>;
export type AuthResponse = z.infer<typeof authResponseSchema>;
export type BootstrapStatus = z.infer<typeof bootstrapStatusSchema>;
export type BootstrapInitialAdminRequest = z.infer<typeof bootstrapInitialAdminRequestSchema>;

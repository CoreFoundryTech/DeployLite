import type {
  AgentRepository,
  AuditRepository,
  AuthUserRepository,
  DeploymentCommandRepository,
  DeploymentRepository,
  EnvSecretValueRepository,
  ProjectRepository,
  RoleRepository,
  SessionRepository,
  UserRepository
} from "@deploylite/domain";

export { closeDbPool, createDbClient, createDbPool, type DeployLiteDb } from "./client.js";
export {
  assertEnvMetadataHasNoValueColumns,
  assertEnvSecretValuesInputHasNoRawValueColumns,
  toEnvVariableMetadataInsert,
  type EnvVariableMetadataInput
} from "./env-metadata.js";
export { BcryptPasswordHasher } from "./auth/passwords.js";
export { createOpaqueSessionToken, hashSessionToken, isSessionUsable, verifySessionToken, type CreatedSessionToken } from "./auth/sessions.js";
export { bootstrapInitialAdmin, type BootstrapInitialAdminInput } from "./auth/bootstrap.js";
export * from "./repositories/index.js";
export * from "./schema.js";

export type DeployLiteRepositories = {
  agents: AgentRepository;
  audit: AuditRepository;
  deploymentCommands: DeploymentCommandRepository;
  deployments: DeploymentRepository;
  envSecretValues: EnvSecretValueRepository;
  projects: ProjectRepository;
  roles: RoleRepository;
  sessions: SessionRepository;
  users: UserRepository;
  authUsers: AuthUserRepository;
};

export const dbBoundary = "repository-adapter-placeholder-with-schema-migrations";

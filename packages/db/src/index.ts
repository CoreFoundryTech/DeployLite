import type { AgentRepository, DeploymentRepository, ProjectRepository, UserRepository } from "@deploylite/domain";

export { closeDbPool, createDbClient, createDbPool, type DeployLiteDb } from "./client.js";
export { assertEnvMetadataHasNoValueColumns, toEnvVariableMetadataInsert, type EnvVariableMetadataInput } from "./env-metadata.js";
export * from "./schema.js";

export type DeployLiteRepositories = {
  agents: AgentRepository;
  deployments: DeploymentRepository;
  projects: ProjectRepository;
  users: UserRepository;
};

export const dbBoundary = "repository-adapter-placeholder-with-schema-migrations";

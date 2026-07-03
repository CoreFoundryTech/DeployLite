import type { AgentRepository, DeploymentRepository, ProjectRepository, UserRepository } from "@deploylite/domain";

export type DeployLiteRepositories = {
  agents: AgentRepository;
  deployments: DeploymentRepository;
  projects: ProjectRepository;
  users: UserRepository;
};

export const dbBoundary = "repository-adapter-placeholder-no-migrations-yet";

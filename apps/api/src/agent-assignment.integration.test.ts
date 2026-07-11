import { createEnvSecretCipher, loadEnvSecretKey } from "@deploylite/config";
import type { Agent, Project } from "@deploylite/contracts";
import {
  InMemoryAgentRepository,
  InMemoryDeploymentCommandRepository,
  InMemoryDeploymentRepository,
  InMemoryEnvSecretValueRepository,
  InMemoryEnvVariableMetadataRepository,
  type ProjectRepository
} from "@deploylite/domain";
import { describe, expect, it } from "vitest";
import { buildApiApp } from "./app.js";

const now = new Date("2026-07-10T12:00:00.000Z");
const agentId = "11111111-1111-4111-8111-111111111111";
const wrongAgentId = "22222222-2222-4222-8222-222222222222";
const projectId = "33333333-3333-4333-8333-333333333333";
const secretKey = "assignment-test-secret-key-1234567890abcdef";

class ProjectMemory implements ProjectRepository {
  readonly records = new Map<string, Project>();
  async save(project: Project) { this.records.set(project.id, structuredClone(project)); return project; }
  async findById(id: string) { return this.records.get(id) ?? null; }
  async list() { return [...this.records.values()]; }
  async remove(id: string) { return this.records.delete(id); }
}

async function setup(agent: Agent | null) {
  const agents = new InMemoryAgentRepository();
  const deployments = new InMemoryDeploymentRepository();
  const commands = new InMemoryDeploymentCommandRepository();
  const projects = new ProjectMemory();
  const metadata = new InMemoryEnvVariableMetadataRepository();
  const secrets = new InMemoryEnvSecretValueRepository();
  if (agent) await agents.save(agent);
  await projects.save({ id: projectId, name: "Service", repoUrl: "https://github.com/acme/service.git", defaultBranch: "main", buildCommand: null, runCommand: null, port: 3000, description: null, imageTag: null });
  const app = await buildApiApp({
    env: { NODE_ENV: "test", DEPLOYLITE_AGENT_ID: agentId, DEPLOYLITE_AGENT_TOKEN: "bound-agent-token-1234567890-abcdef", DEPLOYLITE_SECRET_KEY: secretKey },
    state: { agents, deployments, projects, deploymentCommands: commands, envMetadata: metadata, envSecretValues: secrets, envSecretMaterialization: secrets, envSecretCipher: createEnvSecretCipher(loadEnvSecretKey(secretKey)) },
    now: () => now
  });
  const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", headers: { "content-type": "application/json" }, payload: { email: "admin@example.test", password: "deploylite-admin-password" } });
  return { app, agents, deployments, commands, cookie: login.headers["set-cookie"] as string };
}

function agent(id: string, status: Agent["status"], lastHeartbeatAt: string | null): Agent {
  return { id, name: "Agent", endpoint: "http://agent.test", status, lastHeartbeatAt, resourceSnapshot: null };
}

describe("deployment agent assignment freshness", () => {
  it("accepts only the configured agent with a fresh online heartbeat", async () => {
    const test = await setup(agent(agentId, "online", now.toISOString()));
    const response = await test.app.inject({ method: "POST", url: `/api/v1/projects/${projectId}/deployments`, headers: { cookie: test.cookie, "content-type": "application/json" }, payload: { agentId } });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.deployment.agentId).toBe(agentId);
    expect(await test.commands.list()).toHaveLength(1);
  });

  it.each([
    ["stale", agent(agentId, "online", new Date(now.getTime() - 60_001).toISOString()), agentId],
    ["offline", agent(agentId, "offline", now.toISOString()), agentId],
    ["missing", null, agentId],
    ["wrong bound identity", agent(wrongAgentId, "online", now.toISOString()), wrongAgentId]
  ])("rejects %s explicit assignment without deployment or command writes", async (_label, candidate, requestedId) => {
    const test = await setup(candidate);
    const beforeDeployments = (await test.deployments.list()).length;
    const beforeCommands = (await test.commands.list()).length;
    const response = await test.app.inject({ method: "POST", url: `/api/v1/projects/${projectId}/deployments`, headers: { cookie: test.cookie, "content-type": "application/json" }, payload: { agentId: requestedId } });
    expect(response.statusCode).toBe(409);
    expect((await test.deployments.list()).length).toBe(beforeDeployments);
    expect((await test.commands.list()).length).toBe(beforeCommands);
  });
});

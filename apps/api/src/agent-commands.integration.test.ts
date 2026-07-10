import { createEnvSecretCipher, loadEnvSecretKey } from "@deploylite/config";
import type { Agent, Deployment, DeploymentCommand, Project } from "@deploylite/contracts";
import {
  InMemoryAgentRepository,
  InMemoryDeploymentCommandRepository,
  InMemoryDeploymentRepository,
  InMemoryEnvSecretValueRepository,
  InMemoryEnvVariableMetadataRepository,
  type ProjectRepository
} from "@deploylite/domain";
import { HttpAgentCommandTransport } from "@deploylite/agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApiApp } from "./app.js";

const agentId = "11111111-1111-4111-8111-111111111111";
const otherAgentId = "22222222-2222-4222-8222-222222222222";
const projectId = "33333333-3333-4333-8333-333333333333";
const deploymentId = "44444444-4444-4444-8444-444444444444";
const commandId = "55555555-5555-4555-8555-555555555555";
const token = "agent-token-for-tests-1234567890abcdef";
const secretKey = "env-secret-key-for-tests-1234567890abcdef";
const plaintext = "lowercase-private-value-that-must-not-persist";

class MemoryProjectRepository implements ProjectRepository {
  readonly projects = new Map<string, Project>();
  async save(project: Project) { this.projects.set(project.id, structuredClone(project)); return project; }
  async findById(id: string) { return this.projects.get(id) ?? null; }
  async list() { return [...this.projects.values()]; }
  async remove(id: string) { return this.projects.delete(id); }
}

function command(overrides: Partial<DeploymentCommand> = {}): DeploymentCommand {
  return {
    id: commandId,
    deploymentId,
    agentId,
    kind: "start",
    state: "pending",
    payload: { projectId, commitSha: "abcdef1" },
    requestedBy: null,
    requestId: "66666666-6666-4666-8666-666666666666",
    correlationId: "77777777-7777-4777-8777-777777777777",
    issuedAt: "2026-07-10T00:00:00.000Z",
    claimedAt: null,
    completedAt: null,
    failureReason: null,
    ...overrides
  };
}

async function fixture(commandOverrides: Partial<DeploymentCommand> = {}) {
  const agents = new InMemoryAgentRepository();
  const deployments = new InMemoryDeploymentRepository();
  const projects = new MemoryProjectRepository();
  const commands = new InMemoryDeploymentCommandRepository();
  const metadata = new InMemoryEnvVariableMetadataRepository();
  const secrets = new InMemoryEnvSecretValueRepository();
  const cipher = createEnvSecretCipher(loadEnvSecretKey(secretKey));
  const agent: Agent = { id: agentId, name: "Agent", endpoint: "http://agent.test", status: "online", lastHeartbeatAt: null, resourceSnapshot: null };
  const project: Project = { id: projectId, name: "Service", repoUrl: "https://github.com/acme/service.git", defaultBranch: "main", buildCommand: null, runCommand: null, port: 3000, description: null, imageTag: null };
  const deployment: Deployment = { id: deploymentId, projectId, agentId, status: "queued", commitSha: "abcdef1", startedAt: "2026-07-10T00:00:00.000Z", finishedAt: null };
  await agents.save(agent);
  await projects.save(project);
  await deployments.save(deployment);
  await commands.save(command(commandOverrides));
  await metadata.upsert({ id: "88888888-8888-4888-8888-888888888888", projectId, key: "private_key", scope: "project", valuePresent: true, valueFingerprint: cipher.fingerprint(plaintext), required: true, description: null, updatedAt: "2026-07-10T00:00:00.000Z" });
  await secrets.upsert({ projectId, key: "private_key", scope: "project", encryptedValue: Buffer.from(cipher.encrypt(plaintext), "base64"), valueFingerprint: cipher.fingerprint(plaintext), keyVersion: 1 });
  const app = await buildApiApp({
    db: { pool: {} as never, client: {} as never },
    env: { NODE_ENV: "test", DATABASE_URL: "postgres://user:pass@localhost:5432/deploylite", DEPLOYLITE_AGENT_ID: agentId, DEPLOYLITE_AGENT_TOKEN: token, DEPLOYLITE_SECRET_KEY: secretKey },
    state: { agents, deployments, projects, deploymentCommands: commands, envMetadata: metadata, envSecretValues: secrets, envSecretMaterialization: secrets, envSecretCipher: cipher }
  });
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const url = new URL(String(input));
    const response = await app.inject({
      method: (init?.method ?? "GET") as "GET" | "POST",
      url: `${url.pathname}${url.search}`,
      headers: init?.headers as Record<string, string> | undefined,
      payload: init?.body ? String(init.body) : undefined
    });
    return new Response(response.statusCode === 204 ? null : response.body, { status: response.statusCode, headers: response.headers as Record<string, string> });
  });
  const transport = new HttpAgentCommandTransport({ apiUrl: "http://api.test", token, fetch });
  return { app, commands, secrets, transport };
}

afterEach(() => vi.restoreAllMocks());

describe("agent command HTTP transport integration", () => {
  it("denies missing and invalid bearer credentials without exposing the configured token", async () => {
    const { app } = await fixture();
    const missing = await app.inject({ method: "GET", url: `/api/v1/agent/commands/next?agentId=${agentId}` });
    const invalid = await app.inject({ method: "GET", url: `/api/v1/agent/commands/next?agentId=${agentId}`, headers: { authorization: "Bearer wrong-token" } });
    expect(missing.statusCode).toBe(401);
    expect(invalid.statusCode).toBe(403);
    expect(`${missing.body}${invalid.body}`).not.toContain(token);
  });

  it("isolates the configured agent from cross-agent queries and commands", async () => {
    const { app, commands } = await fixture();
    const crossQuery = await app.inject({ method: "GET", url: `/api/v1/agent/commands/next?agentId=${otherAgentId}`, headers: { authorization: `Bearer ${token}` } });
    await commands.save(command({ id: "99999999-9999-4999-8999-999999999999", agentId: otherAgentId }));
    const crossClaim = await app.inject({ method: "POST", url: "/api/v1/agent/commands/99999999-9999-4999-8999-999999999999/claim", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, payload: { agentId } });
    expect(crossQuery.statusCode).toBe(403);
    expect(crossClaim.statusCode).toBe(404);
  });

  it("polls complete execution input, claims, and completes idempotently without persisting plaintext", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { commands, secrets, transport } = await fixture();
    const input = await transport.poll(agentId, new AbortController().signal);
    expect(input).toMatchObject({ command: { id: commandId, agentId, state: "pending" }, repoUrl: "https://github.com/acme/service.git", ref: "abcdef1", projectSlug: projectId, healthUrl: "http://127.0.0.1:3000/" });
    expect(input?.envFile.contents).toBe(`private_key=${plaintext}\n`);
    expect((await transport.claim(commandId, agentId))?.state).toBe("claimed");
    expect((await transport.complete(commandId, { token: plaintext }))?.state).toBe("completed");
    expect((await transport.complete(commandId))?.state).toBe("completed");
    expect(JSON.stringify(await commands.list())).not.toContain(plaintext);
    expect(JSON.stringify(await secrets.listByProject(projectId))).not.toContain(plaintext);
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("fails an assigned claimed command idempotently with a redacted reason", async () => {
    const { commands, transport } = await fixture({ state: "claimed", claimedAt: "2026-07-10T00:00:01.000Z" });
    const reason = `private_key=-----BEGIN PRIVATE KEY-----\n${plaintext}\n-----END PRIVATE KEY-----`;
    expect((await transport.fail(commandId, reason))?.state).toBe("failed");
    expect((await transport.fail(commandId, reason))?.state).toBe("failed");
    const persisted = await commands.findById(commandId);
    expect(persisted?.failureReason).not.toContain(plaintext);
    expect(persisted?.failureReason).toContain("private_key=[REDACTED]");
  });
});

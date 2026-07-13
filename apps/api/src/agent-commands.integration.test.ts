import { createEnvSecretCipher, loadEnvSecretKey } from "@deploylite/config";
import type { Agent, Deployment, DeploymentCommand, Project } from "@deploylite/contracts";
import {
  AgentStatusService,
  InMemoryAgentRepository,
  InMemoryDeploymentCommandRepository,
  InMemoryDeploymentRepository,
  InMemoryEnvSecretValueRepository,
  InMemoryEnvVariableMetadataRepository,
  type AuditEvent,
  type AuditEventInput,
  type AuditRepository,
  type DeploymentCommandProjectionRepository,
  type DeploymentCommandRepository,
  type ProjectRepository
} from "@deploylite/domain";
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

class TestAgentTransport {
  constructor(private readonly fetch: typeof globalThis.fetch) {}
  register(input: unknown, signal: AbortSignal) { return this.request("/api/v1/agent/register", { method: "POST", signal, body: JSON.stringify(input) }); }
  heartbeat(id: string, observedAt: string, resourceSnapshot: unknown, signal: AbortSignal) { return this.request(`/api/v1/agent/${id}/heartbeat`, { method: "POST", signal, body: JSON.stringify({ agentId: id, observedAt, resourceSnapshot }) }); }
  poll(id: string, signal: AbortSignal) { return this.request(`/api/v1/agent/commands/next?agentId=${id}`, { method: "GET", signal }); }
  claim(id: string, assignedAgentId: string) { return this.request(`/api/v1/agent/commands/${id}/claim`, { method: "POST", body: JSON.stringify({ agentId: assignedAgentId }) }); }
  renewLease(id: string, assignedAgentId: string) { return this.request(`/api/v1/agent/commands/${id}/renew`, { method: "POST", body: JSON.stringify({ agentId: assignedAgentId }) }); }
  complete(id: string, output?: Record<string, unknown>) { return this.request(`/api/v1/agent/commands/${id}/complete`, { method: "POST", body: JSON.stringify({ output }) }); }
  fail(id: string, reason: string) { return this.request(`/api/v1/agent/commands/${id}/fail`, { method: "POST", body: JSON.stringify({ reason }) }); }
  projectRunning(id: string, assignedAgentId: string) { return this.request(`/api/v1/agent/commands/${id}/running`, { method: "POST", body: JSON.stringify({ agentId: assignedAgentId }) }); }
  private async request(path: string, init: RequestInit): Promise<any | null> {
    const response = await this.fetch(new URL(path, "http://api.test"), { ...init, headers: { "content-type": "application/json", authorization: `Bearer ${token}` } });
    if (response.status === 204) return null;
    if (!response.ok) throw new Error(`Agent API request failed with status ${response.status}`);
    return response.json();
  }
}

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
    leaseExpiresAt: null,
    completedAt: null,
    failureReason: null,
    ...overrides
  };
}

async function fixture(commandOverrides: Partial<DeploymentCommand> = {}, registerAgent = true, now: () => Date = () => new Date("2026-07-10T00:00:05.000Z"), commandReconciliationIntervalMs?: number, commandRepository?: DeploymentCommandRepository) {
  const agents = new InMemoryAgentRepository();
  const deployments = new InMemoryDeploymentRepository();
  const projects = new MemoryProjectRepository();
  const auditInputs: AuditEventInput[] = [];
  const audit: AuditRepository = {
    append: async (entry) => {
      auditInputs.push(entry);
      return { id: `audit-${auditInputs.length}`, actorId: entry.actorUserId ?? "system", action: entry.action, targetType: entry.targetType, targetId: entry.targetId, requestId: entry.requestId, correlationId: entry.correlationId, timestamp: new Date().toISOString() } as AuditEvent;
    },
    list: async () => ({ events: [], total: 0, limit: 50, offset: 0 })
  };
  const commands = commandRepository ?? new InMemoryDeploymentCommandRepository({ deployments, audit, now });
  const metadata = new InMemoryEnvVariableMetadataRepository();
  const secrets = new InMemoryEnvSecretValueRepository();
  const cipher = createEnvSecretCipher(loadEnvSecretKey(secretKey));
  const agent: Agent = { id: agentId, name: "Agent", endpoint: "http://agent.test", status: "online", lastHeartbeatAt: null, resourceSnapshot: null };
  const project: Project = { id: projectId, name: "Service", repoUrl: "https://github.com/acme/service.git", defaultBranch: "main", buildCommand: null, runCommand: null, port: 3000, description: null, imageTag: null };
  const deployment: Deployment = { id: deploymentId, projectId, agentId, status: "queued", commitSha: "abcdef1", startedAt: "2026-07-10T00:00:00.000Z", finishedAt: null };
  if (registerAgent) await agents.save(agent);
  await projects.save(project);
  await deployments.save(deployment);
  await commands.save(command(commandOverrides));
  await metadata.upsert({ id: "88888888-8888-4888-8888-888888888888", projectId, key: "private_key", scope: "project", valuePresent: true, valueFingerprint: cipher.fingerprint(plaintext), required: true, description: null, updatedAt: "2026-07-10T00:00:00.000Z" });
  await secrets.upsert({ projectId, key: "private_key", scope: "project", encryptedValue: Buffer.from(cipher.encrypt(plaintext), "base64"), valueFingerprint: cipher.fingerprint(plaintext), keyVersion: 1 });
  const app = await buildApiApp({
    db: { pool: {} as never, client: {} as never },
    env: { NODE_ENV: "test", DATABASE_URL: "postgres://user:pass@localhost:5432/deploylite", DEPLOYLITE_AGENT_ID: agentId, DEPLOYLITE_AGENT_TOKEN: token, DEPLOYLITE_SECRET_KEY: secretKey },
    auth: { audit },
    state: { agents, deployments, projects, deploymentCommands: commands, envMetadata: metadata, envSecretValues: secrets, envSecretMaterialization: secrets, envSecretCipher: cipher },
    now,
    commandReconciliationIntervalMs
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
  const transport = new TestAgentTransport(fetch);
  return { app, agents, commands, deployments, projects, metadata, secrets, transport, auditInputs };
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("agent command HTTP transport integration", () => {
  it("registers a fresh agent idempotently and records authenticated heartbeats", async () => {
    let now = new Date("2026-07-10T00:00:05.000Z");
    const { agents, transport } = await fixture({}, false, () => now);
    const resourceSnapshot = { cpuLoad: 0.2, memoryUsedBytes: 10, memoryTotalBytes: 100, diskUsedBytes: 20, diskTotalBytes: 200 };
    const registration = { agentId, name: "Production agent", endpoint: "http://agent:3002", observedAt: "2026-07-10T00:00:00.000Z", resourceSnapshot };
    await expect(transport.poll(agentId, new AbortController().signal)).resolves.toBeNull();
    await expect(transport.register(registration, new AbortController().signal)).resolves.toMatchObject({ id: agentId, status: "online", lastHeartbeatAt: now.toISOString() });
    await expect(transport.register({ ...registration, name: "Production agent restarted" }, new AbortController().signal)).resolves.toMatchObject({ id: agentId, name: "Production agent restarted" });
    now = new Date("2026-07-10T00:00:30.000Z");
    await expect(transport.heartbeat(agentId, "2026-07-10T00:00:29.000Z", { ...resourceSnapshot, cpuLoad: 0.3 }, new AbortController().signal)).resolves.toMatchObject({ id: agentId, status: "online", lastHeartbeatAt: now.toISOString(), resourceSnapshot: { cpuLoad: 0.3 } });
    await expect(transport.heartbeat(agentId, "2026-07-10T01:00:30.000Z", resourceSnapshot, new AbortController().signal)).rejects.toThrow("status 400");
    expect(await agents.findById(agentId)).toMatchObject({ status: "online", lastHeartbeatAt: now.toISOString() });
    expect(await agents.list()).toHaveLength(1);
  });

  it("rejects future and past observedAt skew without making an agent eligible", async () => {
    const { agents, commands, transport } = await fixture({}, false, () => new Date("2026-07-10T00:05:00.000Z"));
    const resourceSnapshot = { cpuLoad: 0.2, memoryUsedBytes: 10, memoryTotalBytes: 100, diskUsedBytes: 20, diskTotalBytes: 200 };
    const registration = { agentId, name: "Skewed agent", endpoint: "http://agent:3002", resourceSnapshot };
    await expect(transport.register({ ...registration, observedAt: "2026-07-10T01:05:00.000Z" }, new AbortController().signal)).rejects.toThrow("status 400");
    await expect(transport.register({ ...registration, observedAt: "2026-07-09T23:05:00.000Z" }, new AbortController().signal)).rejects.toThrow("status 400");
    await expect(transport.poll(agentId, new AbortController().signal)).resolves.toBeNull();
    expect(await agents.list()).toEqual([]);
    expect((await commands.findById(commandId))?.state).toBe("pending");
  });

  it("uses server receipt time for freshness and becomes stale after the server threshold", async () => {
    let now = new Date("2026-07-10T00:05:00.000Z");
    const test = await fixture({}, false, () => now);
    const resourceSnapshot = { cpuLoad: 0.2, memoryUsedBytes: 10, memoryTotalBytes: 100, diskUsedBytes: 20, diskTotalBytes: 200 };
    await test.transport.register({ agentId, name: "Agent", endpoint: "http://agent:3002", observedAt: "2026-07-10T00:05:30.000Z", resourceSnapshot }, new AbortController().signal);
    expect((await test.agents.findById(agentId))?.lastHeartbeatAt).toBe("2026-07-10T00:05:00.000Z");
    now = new Date("2026-07-10T00:06:01.001Z");
    const stored = await test.agents.findById(agentId);
    expect(stored && new AgentStatusService(test.agents).markStale(stored, now).status).toBe("stale");
  });

  it("denies registration token failures and isolates the bound agent id", async () => {
    const { app, agents } = await fixture({}, false);
    const payload = { agentId, name: "Agent", endpoint: "http://agent:3002", observedAt: "2026-07-10T00:00:00.000Z", resourceSnapshot: { cpuLoad: 0.2, memoryUsedBytes: 10, memoryTotalBytes: 100, diskUsedBytes: 20, diskTotalBytes: 200 } };
    const denied = await app.inject({ method: "POST", url: "/api/v1/agent/register", headers: { authorization: "Bearer wrong-token", "content-type": "application/json" }, payload });
    const isolated = await app.inject({ method: "POST", url: "/api/v1/agent/register", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, payload: { ...payload, agentId: otherAgentId } });
    const heartbeatIsolated = await app.inject({ method: "POST", url: `/api/v1/agent/${agentId}/heartbeat`, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, payload: { agentId: otherAgentId, observedAt: payload.observedAt, resourceSnapshot: payload.resourceSnapshot } });
    expect(denied.statusCode).toBe(403);
    expect(isolated.statusCode).toBe(403);
    expect(heartbeatIsolated.statusCode).toBe(403);
    expect(await agents.list()).toEqual([]);
    expect(`${denied.body}${isolated.body}${heartbeatIsolated.body}`).not.toContain(token);
  });

  it("denies missing and invalid bearer credentials without exposing the configured token", async () => {
    const { app, commands, deployments } = await fixture();
    const missing = await app.inject({ method: "GET", url: `/api/v1/agent/commands/next?agentId=${agentId}` });
    const invalid = await app.inject({ method: "GET", url: `/api/v1/agent/commands/next?agentId=${agentId}`, headers: { authorization: "Bearer wrong-token" } });
    const invalidClaim = await app.inject({ method: "POST", url: `/api/v1/agent/commands/${commandId}/claim`, headers: { authorization: "Bearer wrong-token", "content-type": "application/json" }, payload: { agentId } });
    expect(missing.statusCode).toBe(401);
    expect(invalid.statusCode).toBe(403);
    expect(invalidClaim.statusCode).toBe(403);
    expect(`${missing.body}${invalid.body}${invalidClaim.body}`).not.toContain(token);
    expect((await commands.findById(commandId))?.state).toBe("pending");
    expect(await deployments.findById(deploymentId)).toMatchObject({ status: "queued", finishedAt: null });
    expect(await deployments.listLogs(deploymentId)).toEqual([]);
  });

  it("isolates the configured agent from cross-agent queries and commands", async () => {
    const { app, commands, deployments } = await fixture();
    const crossQuery = await app.inject({ method: "GET", url: `/api/v1/agent/commands/next?agentId=${otherAgentId}`, headers: { authorization: `Bearer ${token}` } });
    const crossCommandId = "99999999-9999-4999-8999-999999999999";
    await commands.save(command({ id: crossCommandId, agentId: otherAgentId, state: "claimed", claimedAt: "2026-07-10T00:00:01.000Z", leaseExpiresAt: "2026-07-10T00:00:31.000Z" }));
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const crossClaim = await app.inject({ method: "POST", url: `/api/v1/agent/commands/${crossCommandId}/claim`, headers, payload: { agentId } });
    const crossComplete = await app.inject({ method: "POST", url: `/api/v1/agent/commands/${crossCommandId}/complete`, headers, payload: {} });
    const crossFail = await app.inject({ method: "POST", url: `/api/v1/agent/commands/${crossCommandId}/fail`, headers, payload: { reason: "must not apply" } });
    expect(crossQuery.statusCode).toBe(403);
    expect(crossClaim.statusCode).toBe(404);
    expect(crossComplete.statusCode).toBe(404);
    expect(crossFail.statusCode).toBe(404);
    expect(await deployments.findById(deploymentId)).toMatchObject({ status: "queued", finishedAt: null });
    expect(await deployments.listLogs(deploymentId)).toEqual([]);
  });

  it("projects accepted agent execution to running atomically and completes idempotently without persisting plaintext", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { commands, deployments, secrets, transport, auditInputs } = await fixture();
    const input = await transport.poll(agentId, new AbortController().signal);
    expect(input).toMatchObject({ command: { id: commandId, agentId, state: "claimed", leaseExpiresAt: expect.any(String) }, repoUrl: "https://github.com/acme/service.git", ref: "abcdef1", projectSlug: projectId, healthUrl: `http://deploylite-${commandId}:3000/` });
    expect(input?.envFile.contents).toBe(`private_key=${plaintext}\n`);
    expect(await deployments.findById(deploymentId)).toMatchObject({ status: "queued", startedAt: "2026-07-10T00:00:00.000Z", finishedAt: null });
    await expect(transport.projectRunning(commandId, agentId)).resolves.toMatchObject({ applied: true, command: { state: "claimed" } });
    await expect(transport.projectRunning(commandId, agentId)).resolves.toMatchObject({ applied: false, command: { state: "claimed" } });
    expect(await deployments.findById(deploymentId)).toMatchObject({ status: "running", startedAt: "2026-07-10T00:00:00.000Z", finishedAt: null });
    expect((await deployments.listLogs(deploymentId)).filter((log) => log.message.startsWith("Agent claimed deployment command"))).toHaveLength(1);
    expect((await transport.claim(commandId, agentId))?.state).toBe("claimed");
    expect((await transport.claim(commandId, agentId))?.state).toBe("claimed");
    expect((await transport.renewLease(commandId, agentId))?.state).toBe("claimed");
    expect((await deployments.findById(deploymentId))?.status).toBe("running");
    expect((await transport.complete(commandId, { token: plaintext }))?.state).toBe("completed");
    expect((await transport.complete(commandId))?.state).toBe("completed");
    expect(await deployments.findById(deploymentId)).toMatchObject({ status: "succeeded", finishedAt: expect.any(String) });
    const logs = await deployments.listLogs(deploymentId);
    expect(logs).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: expect.stringContaining("deployment is running"), requestId: command().requestId, correlationId: command().correlationId }),
      expect.objectContaining({ message: expect.stringContaining("deployment succeeded"), requestId: command().requestId, correlationId: command().correlationId })
    ]));
    expect(logs.filter((log) => log.message.startsWith("Agent completed deployment command"))).toHaveLength(1);
    expect(logs.filter((log) => log.message.startsWith("Agent claimed deployment command"))).toHaveLength(1);
    expect(auditInputs.filter((event) => event.action === "deployment.running")).toHaveLength(1);
    expect(JSON.stringify(await commands.list())).not.toContain(plaintext);
    expect(JSON.stringify(await secrets.listByProject(projectId))).not.toContain(plaintext);
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("returns the authoritative cancelled or stale command without running effects", async () => {
    let now = new Date("2026-07-10T00:00:05.000Z");
    const cancelled = await fixture({}, true, () => now);
    await cancelled.transport.poll(agentId, new AbortController().signal);
    await cancelled.commands.transitionTerminal(commandId, agentId, "claimed", { state: "cancelled", completedAt: now.toISOString(), leaseExpiresAt: null, failureReason: null, payload: {} });
    await expect(cancelled.transport.projectRunning(commandId, agentId)).resolves.toMatchObject({ applied: false, command: { state: "cancelled" } });
    expect(await cancelled.deployments.findById(deploymentId)).toMatchObject({ status: "queued" });
    expect(await cancelled.deployments.listLogs(deploymentId)).toEqual([]);
    expect(cancelled.auditInputs).toEqual([]);

    let staleNow = new Date("2026-07-10T00:00:29.000Z");
    const stale = await fixture({ state: "claimed", claimedAt: "2026-07-10T00:00:00.000Z", leaseExpiresAt: "2026-07-10T00:00:30.000Z" }, true, () => staleNow);
    staleNow = new Date("2026-07-10T00:00:30.000Z");
    await expect(stale.transport.projectRunning(commandId, agentId)).resolves.toMatchObject({ applied: false, command: { state: "claimed" } });
    expect(await stale.deployments.findById(deploymentId)).toMatchObject({ status: "queued" });
    expect(await stale.deployments.listLogs(deploymentId)).toEqual([]);
    expect(stale.auditInputs).toEqual([]);
  });

  it("does not terminally mutate a command when running projection persistence fails", async () => {
    const test = await fixture();
    await test.transport.poll(agentId, new AbortController().signal);
    vi.spyOn(test.deployments, "save").mockRejectedValueOnce(new Error("running lifecycle write failed"));

    await expect(test.transport.projectRunning(commandId, agentId)).rejects.toThrow("status 500");

    expect(await test.commands.findById(commandId)).toMatchObject({ state: "claimed" });
    expect(await test.deployments.findById(deploymentId)).toMatchObject({ status: "queued", finishedAt: null });
    expect(await test.deployments.listLogs(deploymentId)).toEqual([]);
  });

  it("fails an assigned claimed command idempotently with a redacted reason", async () => {
    const { commands, deployments, transport } = await fixture({ state: "claimed", claimedAt: "2026-07-10T00:00:01.000Z", leaseExpiresAt: "2026-07-10T00:00:31.000Z" });
    const reason = `private_key=-----BEGIN PRIVATE KEY-----\n${plaintext}\n-----END PRIVATE KEY-----`;
    expect((await transport.fail(commandId, reason))?.state).toBe("failed");
    expect((await transport.fail(commandId, reason))?.state).toBe("failed");
    const persisted = await commands.findById(commandId);
    expect(persisted?.failureReason).not.toContain(plaintext);
    expect(persisted?.failureReason).toContain("private_key=[REDACTED]");
    expect(await deployments.findById(deploymentId)).toMatchObject({ status: "failed", finishedAt: expect.any(String) });
    const logs = await deployments.listLogs(deploymentId);
    expect(logs).toEqual([
      expect.objectContaining({ level: "error", message: expect.stringContaining("private_key=[REDACTED]"), requestId: command().requestId, correlationId: command().correlationId })
    ]);
    expect(JSON.stringify(logs)).not.toContain(plaintext);
  });

  it("returns a lease conflict for stale agent failure without system-failing a still-claimed command", async () => {
    let now = new Date("2026-07-10T00:00:29.999Z");
    const leaseExpiresAt = "2026-07-10T00:00:30.000Z";
    const test = await fixture({ state: "claimed", claimedAt: "2026-07-10T00:00:00.000Z", leaseExpiresAt }, true, () => now);
    now = new Date(leaseExpiresAt);
    const response = await test.app.inject({
      method: "POST",
      url: `/api/v1/agent/commands/${commandId}/fail`,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: { reason: "stale agent failure" }
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      data: { authoritativeCommand: { id: commandId, state: "claimed", failureReason: null }, attemptedState: "failed", leaseConflict: true },
      error: { code: "AUTHORITATIVE_LEASE_CONFLICT" }
    });
    expect(await test.deployments.findById(deploymentId)).toMatchObject({ status: "queued", finishedAt: null });
    const logs = await test.deployments.listLogs(deploymentId);
    expect(logs.filter((log) => log.message.startsWith("Agent command lease expired"))).toHaveLength(0);
    expect(logs.filter((log) => log.message.startsWith("Agent reported deployment failure"))).toHaveLength(0);
  });

  it("terminally fails an expired claim and its deployment without requeueing or duplicate reconciliation", async () => {
    let now = new Date("2026-07-10T00:00:05.000Z");
    const test = await fixture({}, true, () => now);
    const claimed = await test.transport.poll(agentId, new AbortController().signal);
    expect(claimed?.command.state).toBe("claimed");
    now = new Date("2026-07-10T00:00:40.000Z");
    await expect(test.transport.poll(agentId, new AbortController().signal)).resolves.toBeNull();
    await expect(test.transport.poll(agentId, new AbortController().signal)).resolves.toBeNull();
    const lateComplete = await test.app.inject({ method: "POST", url: `/api/v1/agent/commands/${commandId}/complete`, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, payload: {} });
    expect(lateComplete.statusCode).toBe(409);
    expect(lateComplete.json()).toMatchObject({ data: { authoritativeCommand: { id: commandId, agentId, state: "failed" }, attemptedState: "completed" }, error: { code: "AUTHORITATIVE_TERMINAL_CONFLICT" } });
    expect(await test.commands.findById(commandId)).toMatchObject({ state: "failed", failureReason: expect.stringContaining("lease expired") });
    expect(await test.deployments.findById(deploymentId)).toMatchObject({ status: "failed", finishedAt: expect.any(String) });
    const logs = await test.deployments.listLogs(deploymentId);
    expect(logs.filter((log) => log.message.startsWith("Agent command lease expired"))).toHaveLength(1);
  });

  it("keeps completion authoritative when expiry reconciliation runs later", async () => {
    let now = new Date("2026-07-10T00:00:05.000Z");
    const test = await fixture({}, true, () => now);
    await test.transport.poll(agentId, new AbortController().signal);
    await expect(test.transport.complete(commandId)).resolves.toMatchObject({ state: "completed" });
    now = new Date("2026-07-10T00:00:40.000Z");
    await expect(test.transport.poll(agentId, new AbortController().signal)).resolves.toBeNull();
    expect(await test.commands.findById(commandId)).toMatchObject({ state: "completed" });
    expect(await test.deployments.findById(deploymentId)).toMatchObject({ status: "succeeded" });
    expect((await test.deployments.listLogs(deploymentId)).filter((log) => log.message.startsWith("Agent completed deployment command"))).toHaveLength(1);
  });

  it("lets lease expiry win when completion reaches terminal persistence at boundary equality", async () => {
    const inner = new InMemoryDeploymentCommandRepository();
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const arrival = new Promise<void>((resolve) => { entered = resolve; });
    const repository: DeploymentCommandRepository & DeploymentCommandProjectionRepository = {
      save: (record) => inner.save(record),
      claim: (...args) => inner.claim(...args),
      renewLease: (...args) => inner.renewLease(...args),
      findById: (id) => inner.findById(id),
      findActiveForDeployment: (id) => inner.findActiveForDeployment(id),
      list: () => inner.list(),
      projectRunning: async () => null,
      async transitionTerminal(...args) {
        if (args[3].state === "completed") {
          entered();
          await gate;
        }
        return inner.transitionTerminal(...args);
      }
    };
    let now = new Date("2026-07-10T00:00:29.000Z");
    const test = await fixture({ state: "claimed", claimedAt: "2026-07-10T00:00:00.000Z", leaseExpiresAt: "2026-07-10T00:00:30.000Z" }, true, () => now, undefined, repository);
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };

    const completion = test.app.inject({ method: "POST", url: `/api/v1/agent/commands/${commandId}/complete`, headers, payload: {} });
    await arrival;
    now = new Date("2026-07-10T00:00:30.000Z");
    release();
    const response = await completion;

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ data: { authoritativeCommand: { state: "failed", failureReason: expect.stringContaining("lease expired") }, attemptedState: "completed" } });
    expect(await test.commands.findById(commandId)).toMatchObject({ state: "failed" });
    expect(await test.deployments.findById(deploymentId)).toMatchObject({ status: "failed", finishedAt: "2026-07-10T00:00:30.000Z" });
    expect((await test.deployments.listLogs(deploymentId)).filter((log) => log.message.startsWith("Agent command failed"))).toHaveLength(1);
  });

  it("returns cancelled as the authoritative conflict for late complete and fail without changing its projection", async () => {
    const completedAt = "2026-07-10T00:00:04.000Z";
    const test = await fixture({ state: "cancelled", completedAt, payload: { cancelledBy: "operator" } });
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };

    const lateComplete = await test.app.inject({ method: "POST", url: `/api/v1/agent/commands/${commandId}/complete`, headers, payload: {} });
    const lateFail = await test.app.inject({ method: "POST", url: `/api/v1/agent/commands/${commandId}/fail`, headers, payload: { reason: "late failure" } });

    expect(lateComplete.statusCode).toBe(409);
    expect(lateComplete.json()).toMatchObject({ data: { authoritativeCommand: { id: commandId, agentId, state: "cancelled", completedAt }, attemptedState: "completed" }, error: { code: "AUTHORITATIVE_TERMINAL_CONFLICT" } });
    expect(lateFail.statusCode).toBe(409);
    expect(lateFail.json()).toMatchObject({ data: { authoritativeCommand: { id: commandId, agentId, state: "cancelled", completedAt }, attemptedState: "failed" }, error: { code: "AUTHORITATIVE_TERMINAL_CONFLICT" } });
    expect(await test.commands.findById(commandId)).toMatchObject({ state: "cancelled", completedAt });
    expect(await test.deployments.findById(deploymentId)).toMatchObject({ status: "canceled", finishedAt: completedAt });
    const logs = await test.deployments.listLogs(deploymentId);
    expect(logs.filter((log) => log.message.startsWith("Deployment command cancelled"))).toEqual([
      expect.objectContaining({ level: "error", timestamp: completedAt, redactionApplied: true, requestId: command().requestId, correlationId: command().correlationId })
    ]);
  });

  it("repairs a cancelled deployment projection on a later terminal retry after a transient write failure", async () => {
    const test = await fixture({ state: "claimed", claimedAt: "2026-07-10T00:00:01.000Z", leaseExpiresAt: "2026-07-10T00:00:31.000Z" });
    const completedAt = "2026-07-10T00:00:04.000Z";
    await test.commands.save(command({ state: "cancelled", completedAt, leaseExpiresAt: null, payload: { cancelledBy: "operator" } }));
    vi.spyOn(test.deployments, "save").mockRejectedValueOnce(new Error("transient cancellation projection failure"));
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };

    const failedRepair = await test.app.inject({ method: "POST", url: `/api/v1/agent/commands/${commandId}/complete`, headers, payload: {} });
    expect(failedRepair.statusCode).toBe(500);
    expect(await test.commands.findById(commandId)).toMatchObject({ state: "cancelled", completedAt });
    expect(await test.deployments.findById(deploymentId)).toMatchObject({ status: "queued", finishedAt: null });

    const repaired = await test.app.inject({ method: "POST", url: `/api/v1/agent/commands/${commandId}/complete`, headers, payload: {} });
    expect(repaired.statusCode).toBe(409);
    expect(await test.deployments.findById(deploymentId)).toMatchObject({ status: "canceled", finishedAt: completedAt });
    expect((await test.deployments.listLogs(deploymentId)).filter((log) => log.message.startsWith("Deployment command cancelled"))).toHaveLength(1);
  });

  it("autonomously reconciles a crashed agent claim after lease expiry without another poll", async () => {
    vi.useFakeTimers();
    let now = new Date("2026-07-10T00:00:05.000Z");
    const test = await fixture({}, true, () => now, 100);
    await test.transport.poll(agentId, new AbortController().signal);
    now = new Date("2026-07-10T00:00:40.000Z");
    await vi.advanceTimersByTimeAsync(100);
    expect(await test.commands.findById(commandId)).toMatchObject({ state: "failed", failureReason: expect.stringContaining("lease expired") });
    expect(await test.deployments.findById(deploymentId)).toMatchObject({ status: "failed" });
    await test.app.close();
    vi.useRealTimers();
  });

  it("repairs a lease-expiry deployment projection after a transient repository failure", async () => {
    vi.useFakeTimers();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let now = new Date("2026-07-10T00:00:05.000Z");
    const test = await fixture({}, true, () => now, 100);
    await test.transport.poll(agentId, new AbortController().signal);
    now = new Date("2026-07-10T00:00:40.000Z");
    vi.spyOn(test.deployments, "save").mockRejectedValueOnce(new Error("transient deployment write failure"));
    await vi.advanceTimersByTimeAsync(100);
    expect(await test.commands.findById(commandId)).toMatchObject({ state: "failed" });
    await vi.advanceTimersByTimeAsync(100);
    expect(await test.deployments.findById(deploymentId)).toMatchObject({ status: "failed", finishedAt: expect.any(String) });
    expect((await test.deployments.listLogs(deploymentId)).filter((log) => log.message.startsWith("Agent command lease expired"))).toHaveLength(1);
    expect(consoleError).toHaveBeenCalledWith("[deployment-command-reconciliation] reconciliation failed");
    await test.app.close();
    vi.useRealTimers();
  });

  it("renews a claimed command lease only for the bound agent", async () => {
    let now = new Date("2026-07-10T00:00:05.000Z");
    const test = await fixture({}, true, () => now);
    const claimed = await test.transport.poll(agentId, new AbortController().signal);
    now = new Date("2026-07-10T00:00:20.000Z");
    const renewed = await test.transport.renewLease(commandId, agentId);
    expect(new Date(renewed!.leaseExpiresAt!).getTime()).toBeGreaterThan(new Date(claimed!.command.leaseExpiresAt!).getTime());
    await expect(test.transport.renewLease(commandId, otherAgentId)).rejects.toThrow("status 403");
  });

  it("does not expire a renewed lease from an older reconciliation snapshot", async () => {
    let now = new Date("2026-07-10T00:00:05.000Z");
    const test = await fixture({}, true, () => now);
    await test.transport.poll(agentId, new AbortController().signal);
    await test.transport.projectRunning(commandId, agentId);
    now = new Date("2026-07-10T00:00:20.000Z");
    await test.transport.renewLease(commandId, agentId);
    now = new Date("2026-07-10T00:00:40.000Z");
    await expect(test.transport.poll(agentId, new AbortController().signal)).resolves.toBeNull();

    expect(await test.commands.findById(commandId)).toMatchObject({ state: "claimed", leaseExpiresAt: "2026-07-10T00:00:50.000Z" });
    expect(await test.deployments.findById(deploymentId)).toMatchObject({ status: "running", finishedAt: null });
    expect((await test.deployments.listLogs(deploymentId)).filter((log) => log.message.startsWith("Agent command lease expired"))).toHaveLength(0);

    await expect(test.transport.complete(commandId)).resolves.toMatchObject({ state: "completed" });
    now = new Date("2026-07-10T00:00:51.000Z");
    await expect(test.transport.poll(agentId, new AbortController().signal)).resolves.toBeNull();
    await expect(test.transport.poll(agentId, new AbortController().signal)).resolves.toBeNull();
    expect(await test.commands.findById(commandId)).toMatchObject({ state: "completed" });
    expect(await test.deployments.findById(deploymentId)).toMatchObject({ status: "succeeded", finishedAt: expect.any(String) });
    const logs = await test.deployments.listLogs(deploymentId);
    expect(logs.filter((log) => log.message.startsWith("Agent command lease expired"))).toHaveLength(0);
    expect(logs.filter((log) => log.message.startsWith("Agent completed deployment command"))).toHaveLength(1);
  });

  it.each(["missing-deployment", "missing-project", "invalid-port", "missing-required-secret", "cipher-failure", "unsupported-prerequisite"])(
    "terminally fails poison command prerequisite: %s",
    async (scenario) => {
      const test = await fixture();
      if (scenario === "missing-deployment") await test.commands.save(command({ deploymentId: otherAgentId }));
      if (scenario === "missing-project") await test.deployments.save({ ...(await test.deployments.findById(deploymentId))!, projectId: otherAgentId });
      if (scenario === "invalid-port") await test.projects.save({ ...(await test.projects.findById(projectId))!, port: null });
      if (scenario === "missing-required-secret") await test.secrets.remove(projectId, "private_key", "project");
      if (scenario === "cipher-failure") await test.secrets.upsert({ projectId, key: "private_key", scope: "project", encryptedValue: Buffer.from("invalid"), valueFingerprint: "redacted", keyVersion: 1 });
      if (scenario === "unsupported-prerequisite") await test.commands.save(command({ kind: "restart" }));

      await expect(test.transport.poll(agentId, new AbortController().signal)).resolves.toBeNull();
      const persisted = await test.commands.findById(commandId);
      expect(persisted).toMatchObject({ state: "failed", completedAt: expect.any(String), leaseExpiresAt: null });
      expect(JSON.stringify([persisted, await test.deployments.listLogs(deploymentId)])).not.toContain(plaintext);
      if (scenario !== "missing-deployment") expect(await test.deployments.findById(deploymentId)).toMatchObject({ status: "failed", finishedAt: expect.any(String) });
    }
  );
});

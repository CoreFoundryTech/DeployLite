import { describe, expect, it, vi } from "vitest";
import {
  createDeployLiteMcpTools,
  createMockDeployLiteApiClient,
  deployLiteMcpToolDefinitions,
  deployLiteMcpTools,
  type DeployLiteApiClient
} from "./index.js";

describe("DeployLite MCP read-only scaffold", () => {
  it("defines only read-only and non-destructive tools", () => {
    const tools = Object.values(deployLiteMcpToolDefinitions);

    expect(tools.map((tool) => tool.name)).toEqual([
      "deploylite_get_server_status",
      "deploylite_list_deployments",
      "deploylite_get_deployment_logs",
      "deploylite_list_projects",
      "deploylite_list_audit_events"
    ]);
    expect(tools).toHaveLength(5);
    for (const tool of tools) {
      expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
      expect(tool.description).toMatch(/Read-only|read-only/);
    }
  });

  it("returns server status with request context and mock-only safety flags", async () => {
    const result = await deployLiteMcpTools.deploylite_get_server_status();

    expect(result.structuredContent).toMatchObject({
      requestId: "mcp_mock_request_1",
      correlationId: "mcp_mock_request_1",
      mode: "mock-only",
      safety: { readOnly: true, destructive: false, dockerSocketAccess: false, hostShellExecution: false, traefikAcmeMutation: false, productionAuthClaims: false }
    });
  });

  it("redacts secret-like deployment log output and keeps reconnect shape", async () => {
    const result = await deployLiteMcpTools.deploylite_get_deployment_logs({ deploymentId: "dep_mock_1", afterSequence: 1 });
    const serialized = JSON.stringify(result);

    expect(result.structuredContent).toMatchObject({
      requestId: "mcp_mock_request_1",
      deploymentId: "dep_mock_1",
      resume: { afterSequence: 1, nextAfterSequence: 2 },
      safety: { readOnly: true, destructive: false, redacted: true }
    });
    expect(serialized).toContain("[REDACTED]");
    expect(serialized).not.toContain("dl_1234567890abcdef");
  });

  it("uses API-shaped deployment filters without mutating data", async () => {
    const tools = deployLiteMcpTools;
    const running = await tools.deploylite_list_deployments({ status: "running" });
    const failed = await tools.deploylite_list_deployments({ status: "failed" });

    expect(running.structuredContent.deployments).toHaveLength(1);
    expect(failed.structuredContent.deployments).toEqual([]);
  });

  it("allows request context injection for cross-surface correlation checks", async () => {
    const apiClient = createMockDeployLiteApiClient("req_cross_surface_1");
    const status = await apiClient.getServerStatus();
    const logs = await apiClient.getDeploymentLogs({ deploymentId: "dep_mock_1" });

    expect(status.requestId).toBe("req_cross_surface_1");
    expect(logs.events.every((event) => event.requestId === "req_cross_surface_1")).toBe(true);
  });
});

describe("DeployLite MCP project and audit visibility", () => {
  const projectA = {
    id: "project_a",
    name: "Álpha https://name-user:name-password@example.test/name",
    repoUrl: "https://repo-user:repo-password@example.test/alpha.git",
    defaultBranch: "https://branch-user:branch-password@example.test/main",
    buildCommand: "printenv SECRET",
    runCommand: "node server.js --token=secret",
    port: 3000,
    description: "https://description-user:description-password@example.test/description",
    imageTag: "https://image-user:image-password@example.test/image",
    unknown: "must-not-leak"
  };
  const projectB = { ...projectA, id: "project_b", name: "beta", repoUrl: "https://example.test/beta.git" };
  const auditEvents = [
    { id: "audit_b", actorId: "actor_1", action: "project.updated", projectId: "project_a", targetType: "project", targetId: "project_a", requestId: "raw_request", correlationId: "raw_correlation", timestamp: "2026-01-02T00:00:00.000Z", metadata: { password: "do-not-leak", unknown: "must-not-leak" } },
    { id: "audit_a", actorId: "actor_1", action: "project.updated", projectId: "project_a", targetType: "project", targetId: "project_a", requestId: "raw_request", correlationId: "raw_correlation", timestamp: "2026-01-02T00:00:00.000Z" },
    { id: "audit_other", actorId: "actor_2", action: "project.deleted", projectId: "project_b", targetType: "project", targetId: "project_b", requestId: "raw_request", correlationId: "raw_correlation", timestamp: "2026-01-01T00:00:00.000Z" }
  ];

  function toolsFor(grants: Array<{ permission: "project.read" | "audit.read"; scope: "platform" | "project"; projectId?: string }>) {
    const client: DeployLiteApiClient = {
      getServerStatus: vi.fn(),
      listDeployments: vi.fn(),
      getDeploymentLogs: vi.fn(),
      listProjects: vi.fn().mockResolvedValue([projectB, projectA]),
      listAuditEvents: vi.fn().mockResolvedValue(auditEvents)
    };
    return { client, tools: createDeployLiteMcpTools(client, { readContext: { actorId: "actor_1", grants } }) };
  }

  it("validates strict inputs and rejects invalid requests before client reads", async () => {
    const { client, tools } = toolsFor([{ permission: "project.read", scope: "platform" }, { permission: "audit.read", scope: "platform" }]);

    await expect(tools.deploylite_list_projects({ unexpected: true })).rejects.toMatchObject({ name: "ZodError" });
    await expect(tools.deploylite_list_audit_events({ action: "", limit: 201 })).rejects.toMatchObject({ name: "ZodError" });

    expect(client.listProjects).not.toHaveBeenCalled();
    expect(client.listAuditEvents).not.toHaveBeenCalled();
  });

  it("uses authorization scopes before reads and denies missing or cross-project audit access", async () => {
    const denied = toolsFor([]);
    await expect(denied.tools.deploylite_list_projects({})).rejects.toMatchObject({ code: "FORBIDDEN", requestId: "mcp_mock_request_1", correlationId: "mcp_mock_request_1" });
    expect(denied.client.listProjects).not.toHaveBeenCalled();

    const projectScoped = toolsFor([{ permission: "project.read", scope: "project", projectId: "project_a" }]);
    const projectScopedResult = await projectScoped.tools.deploylite_list_projects({});
    expect((projectScopedResult.structuredContent as { projects: Array<{ id: string }> }).projects.map((project) => project.id)).toEqual(["project_a"]);

    const scoped = toolsFor([{ permission: "audit.read", scope: "project", projectId: "project_a" }]);
    await expect(scoped.tools.deploylite_list_audit_events({})).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(scoped.tools.deploylite_list_audit_events({ projectId: "project_b" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(scoped.client.listAuditEvents).not.toHaveBeenCalled();
  });

  it("returns deterministic allow-listed project and audit results with exact filters", async () => {
    const { tools } = toolsFor([{ permission: "project.read", scope: "platform" }, { permission: "audit.read", scope: "project", projectId: "project_a" }]);
    const projects = await tools.deploylite_list_projects({});
    const audits = await tools.deploylite_list_audit_events({ projectId: "project_a", action: "project.updated", actor: "actor_1", offset: 0, limit: 1 });
    const projectContent = projects.structuredContent as { projects: Array<{ id: string }> };
    const auditContent = audits.structuredContent as { events: Array<{ id: string }>; requestId: string; correlationId: string; total: number; offset: number; limit: number };

    expect(projectContent.projects.map((project) => project.id)).toEqual(["project_a", "project_b"]);
    expect(auditContent.events.map((event) => event.id)).toEqual(["audit_a"]);
    expect(auditContent).toMatchObject({ requestId: "mcp_mock_request_1", correlationId: "mcp_mock_request_1", total: 2, offset: 0, limit: 1 });
    const serialized = JSON.stringify([projects.structuredContent, projects.content, audits.structuredContent, audits.content]);
    for (const value of ["credential", "printenv", "node server", "must-not-leak", "do-not-leak", "metadata", "repoUrl", "buildCommand", "runCommand"]) {
      expect(serialized).not.toContain(value);
    }
  });

  it("redacts URL userinfo from every retained free-form project field in both MCP representations", async () => {
    const { tools } = toolsFor([{ permission: "project.read", scope: "platform" }]);

    const result = await tools.deploylite_list_projects({});
    const project = (result.structuredContent as { projects: Array<Record<string, unknown>> }).projects.find(({ id }) => id === "project_a");
    const serialized = JSON.stringify([result.structuredContent, result.content]);

    expect(project).toMatchObject({
      name: "Álpha https://[REDACTED]@example.test/name",
      defaultBranch: "https://[REDACTED]@example.test/main",
      description: "https://[REDACTED]@example.test/description",
      imageTag: "https://[REDACTED]@example.test/image"
    });
    for (const value of ["name-user", "name-password", "branch-user", "branch-password", "description-user", "description-password", "image-user", "image-password", "repo-user", "repo-password"]) {
      expect(serialized).not.toContain(value);
    }
  });

  it("returns stable empty pages without mutating its mock-only source", async () => {
    const { client, tools } = toolsFor([{ permission: "audit.read", scope: "platform" }]);
    const defaultPage = await tools.deploylite_list_audit_events();
    const first = await tools.deploylite_list_audit_events({ offset: 99, limit: 50 });
    const second = await tools.deploylite_list_audit_events({ offset: 99, limit: 50 });

    expect(first).toEqual(second);
    expect(first.structuredContent.events).toEqual([]);
    expect(first.structuredContent.total).toBe(3);
    expect(defaultPage.structuredContent).toMatchObject({ offset: 0, limit: 50, total: 3 });
    expect(client.listAuditEvents).toHaveBeenCalledTimes(3);
  });
});

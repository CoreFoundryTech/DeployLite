import { describe, expect, it, vi } from "vitest";
import type { Deployment, Project } from "@deploylite/contracts";
import {
  createDeployLiteMcpTools,
  createMockDeployLiteApiClient,
  deployLiteMcpToolDefinitions,
  deployLiteMcpTools,
  type DeployLiteApiClient,
  type McpReadAuthorizer
} from "./index.js";

describe("DeployLite MCP read-only scaffold", () => {
  it("defines only read-only and non-destructive tools", () => {
    const tools = Object.values(deployLiteMcpToolDefinitions);

    expect(tools.map((tool) => tool.name)).toEqual([
      "deploylite_get_server_status",
      "deploylite_list_deployments",
      "deploylite_get_deployment_logs",
      "deploylite_list_projects",
      "deploylite_list_audit_events",
      "deploylite_get_project_context"
    ]);
    expect(tools).toHaveLength(6);
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
    name: "Álpha https://name-user:name@password@example.test/name",
    repoUrl: "https://repo-user:repo-password@example.test/alpha.git",
    defaultBranch: "https://branch-user:branch@password@example.test/main",
    buildCommand: "printenv SECRET",
    runCommand: "node server.js --token=secret",
    port: 3000,
    description: "https://description-user:description@password@example.test/description",
    imageTag: "https://image-user:image@password@example.test/image",
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

  function contextToolsFor(
    grants: Array<{ permission: "project.read" | "audit.read"; scope: "platform" | "project"; projectId?: string }>,
    projects: Project[] = [projectA],
    deployments: Deployment[] = [
      { id: "dep_a", projectId: "project_a", agentId: "agent_a", status: "succeeded", commitSha: "abcdef1", startedAt: "2026-01-02T00:00:00.000Z", finishedAt: "2026-01-02T00:01:00.000Z" }
    ],
    authorizer?: McpReadAuthorizer
  ) {
    const client: DeployLiteApiClient = {
      getServerStatus: vi.fn(),
      listDeployments: vi.fn().mockResolvedValue({ deployments }),
      getDeploymentLogs: vi.fn(),
      listProjects: vi.fn().mockResolvedValue(projects),
      listAuditEvents: vi.fn()
    };
    return { client, tools: createDeployLiteMcpTools(client, { readContext: { actorId: "actor_1", grants }, ...(authorizer ? { authorizer } : {}) }) };
  }

  it("accepts only an exact valid projectId before authorization or reads", async () => {
    const authorizer: McpReadAuthorizer = { projectScopes: vi.fn(() => "platform" as const), assertAuditScope: vi.fn() };
    const invalid = contextToolsFor([{ permission: "project.read", scope: "platform" }], undefined, undefined, authorizer);
    for (const input of [{}, { projectId: "" }, { projectId: " project_a" }, { projectId: "project/a" }, { projectId: "project_a", extra: true }]) {
      await expect(invalid.tools.deploylite_get_project_context(input)).rejects.toMatchObject({ name: "ZodError" });
    }
    expect(invalid.client.listProjects).not.toHaveBeenCalled();
    expect(invalid.client.listDeployments).not.toHaveBeenCalled();
    expect(authorizer.projectScopes).not.toHaveBeenCalled();

    const valid = contextToolsFor([{ permission: "project.read", scope: "platform" }]);
    await expect(valid.tools.deploylite_get_project_context({ projectId: "project_a" })).resolves.toMatchObject({ structuredContent: { project: { id: "project_a" } } });
    expect(valid.client.listProjects).toHaveBeenCalledTimes(1);
    expect(valid.client.listDeployments).toHaveBeenCalledTimes(1);
  });

  it("denies cross-project reads before all client reads and stops missing projects before deployment reads", async () => {
    const denied = contextToolsFor([{ permission: "project.read", scope: "project", projectId: "project_b" }]);
    await expect(denied.tools.deploylite_get_project_context({ projectId: "project_a" })).rejects.toMatchObject({ code: "FORBIDDEN", requestId: "mcp_mock_request_1", correlationId: "mcp_mock_request_1" });
    expect(denied.client.listProjects).not.toHaveBeenCalled();
    expect(denied.client.listDeployments).not.toHaveBeenCalled();

    const scoped = contextToolsFor([{ permission: "project.read", scope: "project", projectId: "project_a" }]);
    await expect(scoped.tools.deploylite_get_project_context({ projectId: "project_a" })).resolves.toMatchObject({ structuredContent: { project: { id: "project_a" } } });
    expect(scoped.client.listProjects).toHaveBeenCalledTimes(1);
    expect(scoped.client.listDeployments).toHaveBeenCalledTimes(1);

    const missing = contextToolsFor([{ permission: "project.read", scope: "platform" }]);
    await expect(missing.tools.deploylite_get_project_context({ projectId: "project_missing" })).rejects.toMatchObject({ code: "NOT_FOUND", requestId: "mcp_mock_request_1", correlationId: "mcp_mock_request_1" });
    expect(missing.client.listProjects).toHaveBeenCalledTimes(1);
    expect(missing.client.listDeployments).not.toHaveBeenCalled();
  });

  it("selects the latest deployment deterministically and maps advisory readiness exactly", async () => {
    const configuredProject = { ...projectA, buildCommand: "pnpm build", runCommand: "pnpm start", port: 3000, imageTag: "alpha:latest" };
    const deployments: Deployment[] = [
      { id: "dep_a", projectId: "project_a", agentId: "agent_a", status: "failed", commitSha: "abcdef1", startedAt: "2026-01-03T00:00:00.000Z", finishedAt: "2026-01-03T00:01:00.000Z" },
      { id: "dep_z", projectId: "project_a", agentId: "agent_a", status: "succeeded", commitSha: "abcdef2", startedAt: "2026-01-03T00:00:00.000Z", finishedAt: "2026-01-03T00:01:00.000Z" }
    ];
    const { tools } = contextToolsFor([{ permission: "project.read", scope: "platform" }], [configuredProject], deployments);
    const result = await tools.deploylite_get_project_context({ projectId: "project_a" });
    expect(result.structuredContent).toMatchObject({ latestDeployment: { id: "dep_z", status: "succeeded" }, readiness: { status: "ready", reason: "latest_deployment_succeeded", mode: "mock-only", advisory: "non-executing; not production-health evidence" } });

    const readinessCases: Array<[Project, Deployment["status"] | undefined, "ready" | "attention" | "not_configured", string]> = [
      [{ ...configuredProject, buildCommand: null }, "succeeded", "not_configured", "incomplete_configuration"],
      [configuredProject, undefined, "not_configured", "no_deployment"],
      [configuredProject, "queued", "attention", "latest_deployment_queued"],
      [configuredProject, "running", "attention", "latest_deployment_running"],
      [configuredProject, "failed", "attention", "latest_deployment_failed"],
      [configuredProject, "canceled", "attention", "latest_deployment_canceled"]
    ];
    for (const [project, status, expected, reason] of readinessCases) {
      const { tools: readinessTools } = contextToolsFor([{ permission: "project.read", scope: "platform" }], [project], status ? [{ ...deployments[0]!, status }] : []);
      await expect(readinessTools.deploylite_get_project_context({ projectId: "project_a" })).resolves.toMatchObject({ structuredContent: { readiness: { status: expected, reason, mode: "mock-only", advisory: "non-executing; not production-health evidence" } } });
    }
  });

  it("uses an allow-list plus redaction for byte-stable dual output without mutating source fixtures", async () => {
    const sourceProject = { ...projectA, buildCommand: "printenv SECRET", runCommand: "node --token=secret", imageTag: "https://image-user:image-password@example.test/image" };
    const sourceDeployments: Array<Deployment & { credential: string }> = [{ id: "dep_a", projectId: "project_a", agentId: "agent_a", status: "succeeded", commitSha: "abcdef1", startedAt: "2026-01-02T00:00:00.000Z", finishedAt: "2026-01-02T00:01:00.000Z", credential: "do-not-leak" }];
    const before = structuredClone({ sourceProject, sourceDeployments });
    const { client, tools } = contextToolsFor([{ permission: "project.read", scope: "platform" }], [sourceProject], sourceDeployments);
    const first = await tools.deploylite_get_project_context({ projectId: "project_a" });
    const second = await tools.deploylite_get_project_context({ projectId: "project_a" });
    const serialized = JSON.stringify([first.structuredContent, first.content]);

    expect(first.structuredContent).toEqual(second.structuredContent);
    expect(first.content).toEqual(second.content);
    expect(first.content[0]?.text).toBe(JSON.stringify(first.structuredContent));
    expect(client.listDeployments).toHaveBeenCalledWith({});
    expect({ sourceProject, sourceDeployments }).toEqual(before);
    for (const value of ["repoUrl", "buildCommand", "runCommand", "credential", "do-not-leak", "printenv", "node --token", "image-user", "image-password", "must-not-leak"]) {
      expect(serialized).not.toContain(value);
    }
  });
});

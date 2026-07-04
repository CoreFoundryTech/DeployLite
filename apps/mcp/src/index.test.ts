import { describe, expect, it } from "vitest";
import { createMockDeployLiteApiClient, deployLiteMcpToolDefinitions, deployLiteMcpTools } from "./index.js";

describe("DeployLite MCP read-only scaffold", () => {
  it("defines only read-only and non-destructive tools", () => {
    const tools = Object.values(deployLiteMcpToolDefinitions);

    expect(tools.map((tool) => tool.name)).toEqual(["deploylite_get_server_status", "deploylite_list_deployments", "deploylite_get_deployment_logs"]);
    expect(tools).toHaveLength(3);
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

import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import { describe, expect, it } from "vitest";
import {
  DeploymentLifecycle,
  deploymentStreamUrl,
  orderDeploymentLogs,
  redactDeploymentLogMessage,
  runDeploymentControl,
  streamReconnectDelay
} from "./deployment-lifecycle.js";

const deployment = {
  id: "dep-1",
  projectId: "project-1",
  agentId: "agent-1",
  status: "running",
  commitSha: "abcdef1",
  startedAt: "2026-01-01T00:00:00.000Z",
  finishedAt: null
} as const;

const log = (sequence: number, message: string) => ({
  id: `log-${sequence}`,
  deploymentId: deployment.id,
  sequence,
  level: "info" as const,
  message,
  timestamp: "2026-01-01T00:00:00.000Z",
  redactionApplied: true,
  requestId: "request-1",
  correlationId: "request-1"
});

describe("deployment lifecycle", () => {
  it("orders logs, redacts credential-shaped values, and resumes after the last sequence", () => {
    expect(orderDeploymentLogs([log(2, "second"), log(1, "first"), log(2, "duplicate")]).map((item) => item.sequence)).toEqual([1, 2]);
    expect(redactDeploymentLogMessage("DATABASE_URL=postgres://admin:secret@example.test/db")).not.toContain("secret");
    expect(deploymentStreamUrl("https://api.example.test/", deployment.id, 2)).toBe("https://api.example.test/api/v1/deployments/dep-1/logs/stream?afterSequence=2");
    expect(streamReconnectDelay(1)).toBe(1000);
    expect(streamReconnectDelay(99)).toBe(8000);
  });

  it("maps cancel outcomes without pretending unavailable capabilities exist", async () => {
    const cancelled = await runDeploymentControl({
      deploymentId: deployment.id,
      action: "cancel",
      apiBaseUrl: "https://api.example.test",
      fetchImpl: async () => new Response(JSON.stringify({
        data: { deployment: { ...deployment, status: "canceled", finishedAt: "2026-01-01T00:00:10.000Z" }, command: { id: "cmd-1" }, idempotent: true },
        error: null,
        requestId: "request-2"
      }), { status: 200 })
    });
    expect(cancelled).toMatchObject({ kind: "success", deployment: { status: "canceled" }, idempotent: true });

    const unavailable = await runDeploymentControl({
      deploymentId: deployment.id,
      action: "restart",
      apiBaseUrl: "https://api.example.test",
      fetchImpl: async () => new Response(JSON.stringify({ data: null, error: { code: "EXECUTOR_CAPABILITY_UNAVAILABLE", message: "Restart unavailable" }, requestId: "request-3" }), { status: 409 })
    });
    expect(unavailable).toEqual({ kind: "unavailable", message: "Restart unavailable" });
  });

  it("renders an accessible cancel control and transparent unavailable actions", () => {
    const html = renderToStaticMarkup(React.createElement(DeploymentLifecycle, {
      deployment,
      initialLogs: [log(1, "TOKEN=not-for-display")],
      apiBaseUrl: "https://api.example.test"
    }));
    expect(html).toContain('aria-label="Cancel deployment dep-1"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain("Restart unavailable");
    expect(html).toContain("Rollback unavailable");
    expect(html).not.toContain("not-for-display");
  });
});

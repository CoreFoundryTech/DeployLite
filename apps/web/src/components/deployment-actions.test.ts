import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import { describe, expect, it, vi } from "vitest";
import { DeploymentActions, runDeploymentAction } from "./deployment-actions.js";

const input = { deploymentId: "dep-1", action: "cancel" as const, apiBaseUrl: "https://api.example.test" };
const deployment = { id: "dep-1", projectId: "project-1", agentId: "agent-1", status: "succeeded" as const, commitSha: "abc1234", startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:00:02.000Z" };

describe("runDeploymentAction", () => {
  it("posts the selected action and returns a safe success", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ data: {}, error: null, requestId: "req-1" }), { status: 200 }));
    await expect(runDeploymentAction({ ...input, fetchImpl: fetchImpl as unknown as typeof fetch })).resolves.toEqual({ kind: "success" });
    expect(String((fetchImpl.mock.calls[0] as unknown as [RequestInfo | URL])[0])).toBe("https://api.example.test/api/v1/deployments/dep-1/cancel");
  });

  it("classifies auth and unavailable responses without exposing server details", async () => {
    await expect(runDeploymentAction({ ...input, action: "restart", fetchImpl: vi.fn(async () => new Response("agent=secret", { status: 409 })) as unknown as typeof fetch }))
      .resolves.toEqual({ kind: "unavailable", message: "This action is not available for this deployment." });
    await expect(runDeploymentAction({ ...input, fetchImpl: vi.fn(async () => new Response("private", { status: 401 })) as unknown as typeof fetch }))
       .resolves.toEqual({ kind: "error", message: "Your session cannot perform this deployment action. Sign in again or ask an administrator." });
  });

  it("classifies idempotent and terminal cancel responses", async () => {
    await expect(runDeploymentAction({ ...input, fetchImpl: vi.fn(async () => new Response(JSON.stringify({ data: { idempotent: true } }), { status: 200 })) as unknown as typeof fetch }))
      .resolves.toEqual({ kind: "idempotent" });
    await expect(runDeploymentAction({ ...input, fetchImpl: vi.fn(async () => new Response(JSON.stringify({ error: { code: "COMMAND_UNAVAILABLE" } }), { status: 409 })) as unknown as typeof fetch }))
      .resolves.toEqual({ kind: "terminal", message: "This deployment has already reached a terminal state." });
  });
});

describe("DeploymentActions", () => {
  it("renders confirmation controls and disables cancel for terminal deployments", () => {
    const html = renderToStaticMarkup(React.createElement(DeploymentActions, { deployment, apiBaseUrl: "https://api.example.test" }));
    expect(html).toContain("Cancel deployment");
    expect(html).toContain("Rollback");
    expect(html).toContain("disabled");
    expect(html).not.toContain("secret");
  });
});

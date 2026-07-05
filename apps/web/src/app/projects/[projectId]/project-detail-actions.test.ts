import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectDetailActions, submitProjectDeployment } from "./project-detail-actions.js";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() })
}));

const projectFixture = {
  id: "project-1",
  name: "DeployLite",
  repoUrl: "https://github.com/CoreFoundryTech/DeployLite",
  defaultBranch: "main",
  buildCommand: "pnpm build",
  runCommand: "node server.js",
  port: 3000
};

describe("submitProjectDeployment", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns unconfigured when the API base URL is missing", async () => {
    const result = await submitProjectDeployment({
      projectId: projectFixture.id,
      apiBaseUrl: null,
      cookieHeader: "deploylite_session=opaque"
    });

    expect(result).toEqual({ kind: "unconfigured", message: "Configure DEPLOYLITE_WEB_API_BASE_URL before triggering deploys." });
  });

  it("returns triggered with the deployment id and status from the success envelope", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      data: {
        deployment: { id: "dep_abc123", projectId: projectFixture.id, agentId: "agent-1", status: "running", commitSha: "abcdef1", startedAt: "2026-01-01T00:00:00.000Z", finishedAt: null },
        envVariables: [],
        audit: { action: "deployment.trigger", targetType: "deployment", targetId: "dep_abc123" }
      },
      error: null,
      requestId: "req_trigger_1"
    }), { status: 200 }));

    const result = await submitProjectDeployment({
      projectId: projectFixture.id,
      apiBaseUrl: "https://api.example.test",
      cookieHeader: "deploylite_session=opaque",
      fetchImpl: fetchImpl as unknown as typeof fetch
    });

    expect(result).toEqual({ kind: "triggered", deploymentId: "dep_abc123", status: "running" });
    const firstCall = fetchImpl.mock.calls[0] as unknown as [unknown, unknown] | undefined;
    expect(firstCall).toBeDefined();
    const [calledUrl, calledInit] = firstCall ?? [];
    expect(String(calledUrl)).toBe("https://api.example.test/api/v1/projects/project-1/deployments");
    expect(calledInit).toMatchObject({ method: "POST", credentials: "include" });
  });

  it("returns rejected when the API responds with a non-2xx status", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      data: null,
      error: { code: "NO_AGENT_AVAILABLE", message: "No agent online.", correlationId: "req_no_agent" },
      requestId: "req_no_agent"
    }), { status: 409 }));

    const result = await submitProjectDeployment({
      projectId: projectFixture.id,
      apiBaseUrl: "https://api.example.test",
      cookieHeader: "deploylite_session=opaque",
      fetchImpl: fetchImpl as unknown as typeof fetch
    });

    expect(result.kind).toBe("rejected");
    expect(result).toEqual({ kind: "rejected", message: "Could not trigger the deploy. Check that the project has at least one online agent." });
  });

  it("returns invalid when a 2xx success payload does not include a deployment id", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ data: { envVariables: [] }, error: null, requestId: "req_garbage" }), { status: 200 }));

    const result = await submitProjectDeployment({
      projectId: projectFixture.id,
      apiBaseUrl: "https://api.example.test",
      cookieHeader: "deploylite_session=opaque",
      fetchImpl: fetchImpl as unknown as typeof fetch
    });

    expect(result.kind).toBe("invalid");
    expect(result).toEqual({ kind: "invalid", message: "Deploy trigger returned an unexpected response. Try again, and check the API logs if it keeps failing." });
  });

  it("returns invalid when the success body is not parseable JSON", async () => {
    const fetchImpl = vi.fn(async () => new Response("not-json", { status: 200, headers: { "content-type": "text/plain" } }));

    const result = await submitProjectDeployment({
      projectId: projectFixture.id,
      apiBaseUrl: "https://api.example.test",
      cookieHeader: "deploylite_session=opaque",
      fetchImpl: fetchImpl as unknown as typeof fetch
    });

    expect(result.kind).toBe("invalid");
  });

  it("returns unreachable when the fetch call throws", async () => {
    const fetchImpl = vi.fn(async () => { throw new Error("ECONNREFUSED"); });

    const result = await submitProjectDeployment({
      projectId: projectFixture.id,
      apiBaseUrl: "https://api.example.test",
      cookieHeader: "deploylite_session=opaque",
      fetchImpl: fetchImpl as unknown as typeof fetch
    });

    expect(result).toEqual({ kind: "unreachable", message: "The local API is unreachable. Start the API and try again." });
  });
});

describe("ProjectDetailActions render markup", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders the deploy trigger with no status or alert messages by default", () => {
    const html = renderToStaticMarkup(React.createElement(ProjectDetailActions, {
      project: projectFixture,
      apiBaseUrl: "https://api.example.test",
      cookieHeader: "deploylite_session=opaque",
      envVariables: []
    }));

    expect(html).toContain("Deploy latest");
    expect(html).toContain("id=\"deploy-actions\"");
    expect(html).not.toContain("deploy-triggered-status");
    expect(html).not.toContain("deploy-trigger-error");
  });
});

import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cookies } from "next/headers";
import DashboardPage from "./dashboard/page.js";
import DeploymentLogsPage from "./deployments/[deploymentId]/page.js";

vi.mock("next/headers", () => ({
  cookies: vi.fn()
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() })
}));

const apiBaseUrl = "https://api.example.test";

describe("dashboard real API rendering", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete process.env.DEPLOYLITE_WEB_API_BASE_URL;
  });

  it("renders authenticated dashboard metadata from API responses", async () => {
    mockCookies("deploylite_session", "opaque");
    process.env.DEPLOYLITE_WEB_API_BASE_URL = apiBaseUrl;
    mockFetch({
      "/api/v1/auth/me": { data: { user: userFixture }, error: null, requestId: "req_auth_1" },
      "/api/v1/projects": { data: { projects: [projectFixture] }, error: null, requestId: "req_projects_1" },
      "/api/v1/agents": { data: { agents: [agentFixture] }, error: null, requestId: "req_agents_1" },
      "/api/v1/deployments": { data: { deployments: [deploymentFixture] }, error: null, requestId: "req_deployments_1" }
    });

    const html = renderToStaticMarkup(await DashboardPage());

    expect(html).toContain("Platform status");
    expect(html).toContain("Signed in as admin@example.test");
    expect(html).toContain("Primary Agent");
    expect(html).toContain("/deployments/dep-1");
    expect(html).not.toContain("Mock platform status");
  });

  it("renders unauthenticated, empty, and error dashboard states", async () => {
    mockCookies();
    expect(renderToStaticMarkup(await DashboardPage())).toContain("Sign in required");

    mockCookies("deploylite_session", "opaque");
    process.env.DEPLOYLITE_WEB_API_BASE_URL = apiBaseUrl;
    mockFetch({
      "/api/v1/auth/me": { data: { user: userFixture }, error: null, requestId: "req_auth_1" },
      "/api/v1/projects": { data: { projects: [] }, error: null, requestId: "req_projects_1" },
      "/api/v1/agents": { data: { agents: [] }, error: null, requestId: "req_agents_1" },
      "/api/v1/deployments": { data: { deployments: [] }, error: null, requestId: "req_deployments_1" }
    });
    expect(renderToStaticMarkup(await DashboardPage())).toContain("No platform metadata yet");

    mockFetch({
      "/api/v1/auth/me": { data: { user: userFixture }, error: null, requestId: "req_auth_1" },
      "/api/v1/projects": { data: null, error: { code: "FAIL", message: "Failed", correlationId: "req_fail_1" }, requestId: "req_fail_1", status: 500 },
      "/api/v1/agents": { data: { agents: [] }, error: null, requestId: "req_agents_1" },
      "/api/v1/deployments": { data: { deployments: [] }, error: null, requestId: "req_deployments_1" }
    });
    expect(renderToStaticMarkup(await DashboardPage())).toContain("Unable to load platform data");
  });
});

describe("deployment log real API rendering", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete process.env.DEPLOYLITE_WEB_API_BASE_URL;
  });

  it("renders missing deployment and no-log states", async () => {
    mockCookies("deploylite_session", "opaque");
    process.env.DEPLOYLITE_WEB_API_BASE_URL = apiBaseUrl;
    mockFetch({
      "/api/v1/auth/me": { data: { user: userFixture }, error: null, requestId: "req_auth_1" },
      "/api/v1/deployments/missing": { data: null, error: { code: "NOT_FOUND", message: "Deployment not found.", correlationId: "req_missing_1" }, requestId: "req_missing_1", status: 404 },
      "/api/v1/deployments/missing/logs": { data: { events: [] }, error: null, requestId: "req_logs_1" }
    });
    expect(renderToStaticMarkup(await DeploymentLogsPage({ params: Promise.resolve({ deploymentId: "missing" }) }))).toContain("Deployment not found");

    mockFetch({
      "/api/v1/auth/me": { data: { user: userFixture }, error: null, requestId: "req_auth_1" },
      "/api/v1/deployments/dep-1": { data: { deployment: deploymentFixture }, error: null, requestId: "req_deployment_1" },
      "/api/v1/deployments/dep-1/logs": { data: { events: [] }, error: null, requestId: "req_logs_1" }
    });
    expect(renderToStaticMarkup(await DeploymentLogsPage({ params: Promise.resolve({ deploymentId: "dep-1" }) }))).toContain("No log events are available yet.");
  });

  it("renders ordered deployment logs from API responses", async () => {
    mockCookies("deploylite_session", "opaque");
    process.env.DEPLOYLITE_WEB_API_BASE_URL = apiBaseUrl;
    mockFetch({
      "/api/v1/auth/me": { data: { user: userFixture }, error: null, requestId: "req_auth_1" },
      "/api/v1/deployments/dep-1": { data: { deployment: deploymentFixture }, error: null, requestId: "req_deployment_1" },
      "/api/v1/deployments/dep-1/logs": { data: { events: [logFixture(1, "First event"), logFixture(2, "Second event")] }, error: null, requestId: "req_logs_1" }
    });

    const html = renderToStaticMarkup(await DeploymentLogsPage({ params: Promise.resolve({ deploymentId: "dep-1" }) }));

    expect(html).toContain("1 INFO First event");
    expect(html).toContain("2 INFO Second event");
    expect(html.indexOf("1 INFO First event")).toBeLessThan(html.indexOf("2 INFO Second event"));
    expect(html).toContain("Last event ID: 2");
  });
});

function mockCookies(name?: string, value?: string) {
  vi.mocked(cookies).mockResolvedValue({
    getAll: () => (name && value ? [{ name, value }] : [])
  } as never);
}

function mockFetch(routes: Record<string, { data: unknown; error: unknown; requestId: string; status?: number }>) {
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) => {
    const path = new URL(String(url)).pathname;
    const route = routes[path];
    if (!route) {
      return new Response(JSON.stringify({ data: null, error: { code: "NOT_FOUND", message: "Missing fixture", correlationId: "req_missing_fixture" }, requestId: "req_missing_fixture" }), { status: 404 });
    }

    return new Response(JSON.stringify({ data: route.data, error: route.error, requestId: route.requestId }), { status: route.status ?? 200 });
  }));
}

const userFixture = { id: "user-1", email: "admin@example.test", role: "admin", status: "active" };
const projectFixture = { id: "project-1", name: "DeployLite", repoUrl: "https://github.com/CoreFoundryTech/DeployLite", defaultBranch: "main" };
const agentFixture = {
  id: "agent-1",
  name: "Primary Agent",
  endpoint: "https://agent.example.test",
  status: "online",
  lastHeartbeatAt: "2026-01-01T00:00:00.000Z",
  resourceSnapshot: { cpuLoad: 0.5, memoryUsedBytes: 512, memoryTotalBytes: 2048, diskUsedBytes: 1024, diskTotalBytes: 4096 }
};
const deploymentFixture = { id: "dep-1", projectId: "project-1", agentId: "agent-1", status: "running", commitSha: "abcdef1", startedAt: "2026-01-01T00:00:00.000Z", finishedAt: null };

function logFixture(sequence: number, message: string) {
  return {
    id: `log-${sequence}`,
    deploymentId: "dep-1",
    sequence,
    level: "info",
    message,
    timestamp: `2026-01-01T00:00:0${sequence}.000Z`,
    redactionApplied: true,
    requestId: "req_logs_1",
    correlationId: "req_logs_1"
  };
}

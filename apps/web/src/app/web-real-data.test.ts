import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cookies } from "next/headers";
import { InitialAdminSetupPanel, submitInitialAdminSetup } from "./auth-controls.js";
import DashboardPage from "./dashboard/page.js";
import DeploymentLogsPage from "./deployments/[deploymentId]/page.js";
import LoginPage from "./page.js";

vi.mock("next/headers", () => ({
  cookies: vi.fn()
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() })
}));

const apiBaseUrl = "https://api.example.test";

describe("local first-admin login rendering", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete process.env.DEPLOYLITE_WEB_API_BASE_URL;
  });

  it("renders setup-required guidance before normal sign in", async () => {
    mockCookies();
    process.env.DEPLOYLITE_WEB_API_BASE_URL = apiBaseUrl;
    mockFetch({
      "/api/v1/bootstrap/status": { data: { setupRequired: true }, error: null, requestId: "req_bootstrap_1" }
    });

    const html = renderToStaticMarkup(await LoginPage());

    expect(html).toContain("Create the first local admin");
    expect(html).toContain("Normal sign-in stays unavailable until setup creates the first local admin");
    expect(html).toContain("Create first admin");
    expect(html).toContain('aria-label="Create first admin"');
    expect(html).not.toContain("very-secret-admin-password");
  });

  it("renders setup-complete sign-in guidance", async () => {
    mockCookies();
    process.env.DEPLOYLITE_WEB_API_BASE_URL = apiBaseUrl;
    mockFetch({
      "/api/v1/bootstrap/status": { data: { setupRequired: false }, error: null, requestId: "req_bootstrap_1" }
    });

    const html = renderToStaticMarkup(await LoginPage());

    expect(html).toContain("First-admin setup is complete");
    expect(html).toContain("Sign in with API cookie");
    expect(html).not.toContain("Create first admin");
  });

  it("renders safe bootstrap API error guidance", async () => {
    mockCookies();
    process.env.DEPLOYLITE_WEB_API_BASE_URL = apiBaseUrl;
    mockFetch({
      "/api/v1/bootstrap/status": { data: null, error: { code: "FAIL", message: "Failed", correlationId: "req_fail" }, requestId: "req_fail", status: 503 }
    });

    const html = renderToStaticMarkup(await LoginPage());

    expect(html).toContain("Bootstrap status unavailable");
    expect(html).toContain("The local API rejected bootstrap status with status 503");
    expect(html).not.toContain("very-secret-admin-password");
  });

  it("renders authenticated dashboard guidance when a session exists", async () => {
    mockCookies("deploylite_session", "opaque");
    process.env.DEPLOYLITE_WEB_API_BASE_URL = apiBaseUrl;
    mockFetch({
      "/api/v1/auth/me": { data: { user: userFixture }, error: null, requestId: "req_auth_1" },
      "/api/v1/bootstrap/status": { data: { setupRequired: false }, error: null, requestId: "req_bootstrap_1" }
    });

    const html = renderToStaticMarkup(await LoginPage());

    expect(html).toContain("DeployLite admin shell");
    expect(html).toContain("Open dashboard");
  });
});

describe("initial admin setup client interactions", () => {
  it("submits first-admin credentials and reports success without echoing the password", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const result = await submitInitialAdminSetup({
      apiBaseUrl,
      email: "admin@example.test",
      password: "very-secret-admin-password",
      fetchImpl: async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), init });
        return new Response(JSON.stringify({ data: { user: userFixture }, error: null, requestId: "req_admin_1" }), { status: 200 });
      }
    });

    expect(result).toEqual({ kind: "success", message: "First admin created. Sign in with the new local admin account." });
    expect(new URL(calls[0]?.url ?? "").pathname).toBe("/api/v1/bootstrap/initial-admin");
    expect(JSON.stringify(result)).not.toContain("very-secret-admin-password");
  });

  it("reports validation/rejection failures without rendering submitted passwords", async () => {
    const result = await submitInitialAdminSetup({
      apiBaseUrl,
      email: "admin@example.test",
      password: "very-secret-admin-password",
      fetchImpl: async () => new Response(JSON.stringify({ data: null, error: { code: "VALIDATION_ERROR", message: "Invalid", correlationId: "req_invalid" }, requestId: "req_invalid" }), { status: 422 })
    });

    expect(result).toEqual({ kind: "rejected", error: "Initial admin setup failed. Use a valid email and a password with at least 12 characters." });
    expect(JSON.stringify(result)).not.toContain("very-secret-admin-password");
  });

  it("reports locked setup submissions as sign-in guidance", async () => {
    const result = await submitInitialAdminSetup({
      apiBaseUrl,
      email: "admin@example.test",
      password: "very-secret-admin-password",
      fetchImpl: async () => new Response(JSON.stringify({ data: null, error: { code: "BOOTSTRAP_LOCKED", message: "Locked", correlationId: "req_locked" }, requestId: "req_locked" }), { status: 409 })
    });

    expect(result).toEqual({ kind: "locked", error: "Initial admin setup is locked because an admin already exists. Sign in instead." });
  });

  it("renders pending controls as disabled with a discoverable status", () => {
    const html = renderToStaticMarkup(React.createElement(InitialAdminSetupPanel, {
      apiBaseUrl,
      state: {
        message: "Creating the first local admin account.",
        error: "",
        created: false,
        pending: true
      },
      onSubmit: vi.fn()
    }));

    expect(html).toContain("Creating admin...");
    expect(html).toContain("role=\"status\"");
    expect(html).toContain("aria-live=\"polite\"");
    expect(html).toContain("disabled");
  });
});

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
    expect(renderToStaticMarkup(await DashboardPage())).toContain("No projects yet");
    expect(renderToStaticMarkup(await DashboardPage())).toContain("intentionally out of scope");

    mockFetch({
      "/api/v1/auth/me": { data: { user: userFixture }, error: null, requestId: "req_auth_1" },
      "/api/v1/projects": { data: null, error: { code: "FAIL", message: "Failed", correlationId: "req_fail_1" }, requestId: "req_fail_1", status: 500 },
      "/api/v1/agents": { data: { agents: [] }, error: null, requestId: "req_agents_1" },
      "/api/v1/deployments": { data: { deployments: [] }, error: null, requestId: "req_deployments_1" }
    });
    const errorHtml = renderToStaticMarkup(await DashboardPage());
    expect(errorHtml).toContain("Unable to load platform data");
    expect(errorHtml).not.toContain("suggest Docker");
    expect(errorHtml).toContain("Do not start Docker, VPS, Dokploy, Traefik, ACME, DNS, domain, or deployment work");
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
    expect(html).toContain("last event ID: 2");
  });
});

describe("project detail and deploy flow rendering", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete process.env.DEPLOYLITE_WEB_API_BASE_URL;
  });

  it("renders the project detail page with env metadata, build/run/port, and a deploy trigger", async () => {
    mockCookies("deploylite_session", "opaque");
    process.env.DEPLOYLITE_WEB_API_BASE_URL = apiBaseUrl;
    mockFetch({
      "/api/v1/auth/me": { data: { user: userFixture }, error: null, requestId: "req_auth_1" },
      "/api/v1/projects/project-1": { data: { project: projectFixture }, error: null, requestId: "req_project_1" },
      "/api/v1/projects/project-1/env-variables": { data: { envVariables: [{ id: "env-1", projectId: "project-1", key: "DATABASE_URL", scope: "project", valuePresent: false, valueFingerprint: null, required: true, description: "Postgres connection string", updatedAt: "2026-01-01T00:00:00.000Z" }] }, error: null, requestId: "req_env_1" },
      "/api/v1/deployments": { data: { deployments: [deploymentFixture] }, error: null, requestId: "req_dep_list_1" }
    });

    const ProjectDetailPage = (await import("./projects/[projectId]/page.js")).default;
    const html = renderToStaticMarkup(await ProjectDetailPage({ params: Promise.resolve({ projectId: "project-1" }) }));

    expect(html).toContain("DeployLite");
    expect(html).toContain("Build command");
    expect(html).toContain("pnpm build");
    expect(html).toContain("node server.js");
    expect(html).toContain("3000");
    expect(html).toContain("DATABASE_URL");
    expect(html).toContain("Deploy latest");
    expect(html).toContain("Recent deployments");
    expect(html).toContain("/deployments/dep-1");
  });

  it("renders the projects list page with the new project CTA", async () => {
    mockCookies("deploylite_session", "opaque");
    process.env.DEPLOYLITE_WEB_API_BASE_URL = apiBaseUrl;
    mockFetch({
      "/api/v1/auth/me": { data: { user: userFixture }, error: null, requestId: "req_auth_1" },
      "/api/v1/projects": { data: { projects: [projectFixture] }, error: null, requestId: "req_projects_1" },
      "/api/v1/agents": { data: { agents: [agentFixture] }, error: null, requestId: "req_agents_1" },
      "/api/v1/deployments": { data: { deployments: [] }, error: null, requestId: "req_deployments_1" }
    });

    const ProjectsPage = (await import("./projects/page.js")).default;
    const html = renderToStaticMarkup(await ProjectsPage());

    expect(html).toContain("All projects");
    expect(html).toContain("/projects/new");
    expect(html).toContain("/projects/project-1");
    expect(html).toContain("Build");
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
const projectFixture = {
  id: "project-1",
  name: "DeployLite",
  repoUrl: "https://github.com/CoreFoundryTech/DeployLite",
  defaultBranch: "main",
  buildCommand: "pnpm build",
  runCommand: "node server.js",
  port: 3000
};
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

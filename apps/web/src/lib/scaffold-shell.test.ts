import { describe, expect, it } from "vitest";
import { projectSchema } from "@deploylite/contracts";
import { z } from "zod";
import {
  authApiPaths,
  bootstrapApiPaths,
  createAuthApiRequest,
  createInitialAdmin,
  createInitialAdminApiRequest,
  fetchMetadataEnvelope,
  hasSessionCookie,
  loadAuthSession,
  loadBootstrapStatus,
  metadataApiPaths,
  resolveAuthBoundary
} from "./auth-boundary.js";
import { createMockPlatformSnapshot, formatBytes, resolveDashboardShell } from "./scaffold-shell.js";

describe("web scaffold shell state", () => {
  it("blocks anonymous dashboard access without claiming production auth", () => {
    const state = resolveDashboardShell(createMockPlatformSnapshot({ session: null }));

    expect(state).toMatchObject({ kind: "blocked", title: "Sign in required" });
    expect(state.kind === "blocked" ? state.description : "").toContain("not a production auth claim");
  });

  it("marks ready state as cookie-session authenticated", () => {
    const state = resolveDashboardShell(createMockPlatformSnapshot());

    expect(state.kind === "ready" ? state.snapshot.authMode : "").toBe("cookie-session");
    expect(state.kind === "ready" ? state.snapshot.session?.role : null).toBe("operator");
  });

  it("represents loading, empty, and disconnected states", () => {
    expect(resolveDashboardShell(createMockPlatformSnapshot({ state: "loading" })).kind).toBe("loading");
    expect(resolveDashboardShell(createMockPlatformSnapshot({ agents: [], deployments: [], state: "empty" })).kind).toBe("empty");
    expect(resolveDashboardShell(createMockPlatformSnapshot({ state: "disconnected", logView: { deployment: null, events: [], streamState: "disconnected", lastEventId: 2 } }))).toMatchObject({
      kind: "disconnected",
      lastEventId: 2
    });
  });

  it("formats resource sizes for the server status view", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
  });
});

describe("web auth boundary", () => {
  it("detects HttpOnly session-cookie presence without token storage", () => {
    expect(hasSessionCookie("deploylite_session=abc; theme=light")).toBe(true);
    expect(hasSessionCookie("deploylite_session=; theme=light")).toBe(false);
    expect(createAuthApiRequest({ method: "POST", body: { email: "admin@example.test", password: "secret" } })).toMatchObject({
      method: "POST",
      credentials: "include"
    });
  });

  it("resolves canonical authenticated role state", () => {
    expect(resolveAuthBoundary({ id: "user_1", email: "admin@example.test", role: "admin", status: "active" })).toEqual({
      kind: "authenticated",
      user: { id: "user_1", email: "admin@example.test", role: "admin", status: "active" }
    });
  });

  it("loads /auth/me with cookies and rejects malformed auth payloads", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ data: { user: { id: "user_2", email: "operator@example.test", role: "operator", status: "active" } }, error: null, requestId: "req_1" }), { status: 200 });
    };

    const state = await loadAuthSession({ apiBaseUrl: "https://api.example.test", cookieHeader: "deploylite_session=opaque", fetchImpl });

    expect(state).toMatchObject({ kind: "authenticated", user: { role: "operator" } });
    expect(calls[0]).toMatchObject({ url: `https://api.example.test${authApiPaths.me}` });
    expect(calls[0]?.init?.headers).toEqual({ cookie: "deploylite_session=opaque" });
  });

  it("keeps unauthenticated reasons explicit", async () => {
    await expect(loadAuthSession({ apiBaseUrl: "https://api.example.test", cookieHeader: "" })).resolves.toEqual({ kind: "unauthenticated", reason: "missing-cookie" });
    await expect(loadAuthSession({ cookieHeader: "deploylite_session=opaque" })).resolves.toEqual({ kind: "unauthenticated", reason: "api-unconfigured" });
  });
});

describe("web metadata API boundary", () => {
  it("forwards request cookies to metadata endpoints", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ data: { projects: [] }, error: null, requestId: "req_projects_1" }), { status: 200 });
    };

    const result = await fetchMetadataEnvelope({
      apiBaseUrl: "https://api.example.test",
      cookieHeader: "deploylite_session=opaque",
      fetchImpl,
      path: metadataApiPaths.projects,
      schema: z.object({ projects: z.array(projectSchema) })
    });

    expect(result).toMatchObject({ kind: "ready", data: { projects: [] } });
    expect(calls[0]).toMatchObject({ url: "https://api.example.test/api/v1/projects" });
    expect(calls[0]?.init?.headers).toEqual({ cookie: "deploylite_session=opaque" });
  });

  it("returns explicit parse and API failure states", async () => {
    const invalidPayload = await fetchMetadataEnvelope({
      apiBaseUrl: "https://api.example.test",
      cookieHeader: "deploylite_session=opaque",
      fetchImpl: async () => new Response(JSON.stringify({ data: { projects: [{ id: "missing-fields" }] }, error: null, requestId: "req_bad_1" }), { status: 200 }),
      path: metadataApiPaths.projects,
      schema: z.object({ projects: z.array(projectSchema) })
    });

    const apiFailure = await fetchMetadataEnvelope({
      apiBaseUrl: "https://api.example.test",
      cookieHeader: "deploylite_session=opaque",
      fetchImpl: async () => new Response(JSON.stringify({ data: null, error: { code: "NOPE", message: "Nope", correlationId: "req_fail_1" }, requestId: "req_fail_1" }), { status: 503 }),
      path: metadataApiPaths.projects,
      schema: z.object({ projects: z.array(projectSchema) })
    });

    expect(invalidPayload).toEqual({ kind: "error", reason: "invalid-payload" });
    expect(apiFailure).toEqual({ kind: "error", reason: "api-rejected", status: 503 });
  });
});

describe("web bootstrap API boundary", () => {
  it("loads bootstrap status through the typed API envelope", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const result = await loadBootstrapStatus({
      apiBaseUrl: "https://api.example.test",
      cookieHeader: "deploylite_session=opaque",
      fetchImpl: async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), init });
        return new Response(JSON.stringify({ data: { setupRequired: true }, error: null, requestId: "req_bootstrap_1" }), { status: 200 });
      }
    });

    expect(result).toEqual({ kind: "ready", data: { setupRequired: true }, requestId: "req_bootstrap_1" });
    expect(calls[0]).toMatchObject({ url: `https://api.example.test${bootstrapApiPaths.status}` });
  });

  it("returns explicit bootstrap rejected, invalid, unreachable, and unconfigured states", async () => {
    await expect(loadBootstrapStatus({ cookieHeader: "deploylite_session=opaque" })).resolves.toEqual({ kind: "error", reason: "api-unconfigured" });
    await expect(loadBootstrapStatus({ apiBaseUrl: "https://api.example.test", fetchImpl: async () => new Response("{}", { status: 503 }) })).resolves.toEqual({ kind: "error", reason: "api-rejected", status: 503 });
    await expect(loadBootstrapStatus({ apiBaseUrl: "https://api.example.test", fetchImpl: async () => new Response(JSON.stringify({ data: { setupRequired: "yes" }, error: null, requestId: "req_bad" }), { status: 200 }) })).resolves.toEqual({ kind: "error", reason: "invalid-payload" });
    await expect(loadBootstrapStatus({ apiBaseUrl: "https://api.example.test", fetchImpl: async () => { throw new Error("offline"); } })).resolves.toEqual({ kind: "error", reason: "api-unreachable" });
  });

  it("creates initial-admin requests without leaking passwords into URLs or headers", async () => {
    const request = createInitialAdminApiRequest({ email: "admin@example.test", password: "test_fixture_admin_password" });

    expect(request.method).toBe("POST");
    expect(request.credentials).toBe("include");
    expect(request.headers).toEqual({ "content-type": "application/json" });
    expect(JSON.stringify(request.headers)).not.toContain("test_fixture_admin_password");
  });

  it("maps initial-admin success and locked setup submissions", async () => {
    const success = await createInitialAdmin({
      apiBaseUrl: "https://api.example.test",
      input: { email: "admin@example.test", password: "test_fixture_admin_password" },
      fetchImpl: async () => new Response(JSON.stringify({ data: { user: { id: "user_1", email: "admin@example.test", role: "admin", status: "active" } }, error: null, requestId: "req_admin_1" }), { status: 200 })
    });
    const locked = await createInitialAdmin({
      apiBaseUrl: "https://api.example.test",
      input: { email: "admin@example.test", password: "test_fixture_admin_password" },
      fetchImpl: async () => new Response(JSON.stringify({ data: null, error: { code: "BOOTSTRAP_LOCKED", message: "Locked", correlationId: "req_locked" }, requestId: "req_locked" }), { status: 409 })
    });

    expect(success).toMatchObject({ kind: "ready", data: { user: { role: "admin" } } });
    expect(locked).toEqual({ kind: "error", reason: "api-rejected", status: 409 });
  });
});

import { describe, expect, it } from "vitest";
import { authApiPaths, createAuthApiRequest, hasSessionCookie, loadAuthSession, resolveAuthBoundary } from "./auth-boundary.js";
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

import { describe, expect, it } from "vitest";
import { createMockPlatformSnapshot, formatBytes, resolveDashboardShell } from "./scaffold-shell.js";

describe("web scaffold shell state", () => {
  it("blocks anonymous dashboard access without claiming production auth", () => {
    const state = resolveDashboardShell(createMockPlatformSnapshot({ session: null }));

    expect(state).toMatchObject({ kind: "blocked", title: "Scaffold sign-in required" });
    expect(state.kind === "blocked" ? state.description : "").toContain("not production authentication");
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

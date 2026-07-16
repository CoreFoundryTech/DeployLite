import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import type { Deployment } from "@deploylite/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  DeploymentLifecycle,
  deploymentStreamUrl,
  orderDeploymentLogs,
  openDeploymentLifecycleStream,
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

class TestEventSource {
  closed = false;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private readonly listeners = new Map<string, (event: { data: string }) => void>();

  addEventListener(type: string, listener: (event: { data: string }) => void) { this.listeners.set(type, listener); }
  close() { this.closed = true; }
  emit(type: string, data: string) { this.listeners.get(type)?.({ data }); }
}

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

  it("keeps EventSource open for malformed or non-terminal terminal frames and accepts later authoritative updates", () => {
    const source = new TestEventSource();
    const statuses: string[] = [];
    const notices: string[] = [];
    const deployments: Array<Partial<Deployment>> = [];
    const stop = openDeploymentLifecycleStream({
      apiBaseUrl: "https://api.example.test",
      deploymentId: deployment.id,
      afterSequence: null,
      eventSourceFactory: () => source,
      onLog: vi.fn(),
      onStatus: (next) => deployments.push(next),
      onTerminal: vi.fn(),
      onNotice: (message) => notices.push(message),
      onState: (state) => statuses.push(state)
    });

    source.emit("deployment.terminal", "not-json");
    source.emit("deployment.terminal", JSON.stringify({ status: "running" }));
    source.emit("deployment.status", JSON.stringify({ status: "canceling" }));

    expect(source.closed).toBe(false);
    expect(statuses).not.toContain("complete");
    expect(notices).toEqual([
      "A lifecycle terminal frame was ignored because it was invalid.",
      "A lifecycle terminal frame was ignored because it was invalid."
    ]);
    expect(deployments).toEqual([{ status: "canceling" }]);
    stop();
  });

  it("shows reconnecting state and schedules a replacement EventSource after an error", () => {
    const sources: TestEventSource[] = [];
    const states: string[] = [];
    let scheduled: (() => void) | undefined;
    const schedule = vi.fn((callback: () => void) => { scheduled = callback; return 1 as unknown as ReturnType<typeof setTimeout>; });
    const stop = openDeploymentLifecycleStream({
      apiBaseUrl: "https://api.example.test",
      deploymentId: deployment.id,
      afterSequence: 3,
      eventSourceFactory: () => { const source = new TestEventSource(); sources.push(source); return source; },
      onLog: vi.fn(),
      onStatus: vi.fn(),
      onTerminal: vi.fn(),
      onNotice: vi.fn(),
      onState: (state) => states.push(state),
      schedule
    });

    sources[0]?.onerror?.();
    scheduled?.();

    expect(sources[0]?.closed).toBe(true);
    expect(schedule).toHaveBeenCalledWith(expect.any(Function), 1000);
    expect(sources).toHaveLength(2);
    expect(states).toEqual(["connecting", "reconnecting", "reconnecting"]);
    stop();
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

import { describe, expect, it, vi } from "vitest";
import { DeploymentStreamController } from "./use-deployment-stream.js";

const frame = (sequence: number, message = "safe") => `id: ${sequence}\nevent: deployment.log\ndata: ${JSON.stringify({ id: `log-${sequence}`, deploymentId: "dep-1", sequence, level: "info", message, timestamp: "2026-01-01T00:00:00.000Z", redactionApplied: true, requestId: "request-1", correlationId: "request-1" })}\n\n`;

describe("DeploymentStreamController", () => {
  it("resumes with Last-Event-ID, deduplicates events, and stops after a terminal status", async () => {
    const snapshots: unknown[] = [];
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => new Response(frame(2) + frame(2) + "event: deployment.status\ndata: {\"status\":\"succeeded\"}\n\n", { status: 200 }));
    const stream = new DeploymentStreamController({ deploymentId: "dep-1", apiBaseUrl: "https://api.example.test", initialEvents: [JSON.parse(frame(1).match(/data: (.+)/)?.[1] ?? "{}")], fetchImpl: fetchImpl as unknown as typeof fetch }, (snapshot) => snapshots.push(snapshot));
    stream.start();
    await vi.waitFor(() => expect(snapshots.at(-1)).toMatchObject({ state: "stopped", events: [{ sequence: 1 }, { sequence: 2 }] }));
    expect((fetchImpl.mock.calls[0]?.[1] as RequestInit).headers).toEqual({ "Last-Event-ID": "1" });
    stream.stop();
  });

  it("uses bounded exponential reconnects and aborts cleanly", async () => {
    vi.useFakeTimers();
    const states: string[] = [];
    const fetchImpl = vi.fn(async () => { throw new Error("offline"); });
    const stream = new DeploymentStreamController({ deploymentId: "dep-1", apiBaseUrl: "https://api.example.test", fetchImpl: fetchImpl as unknown as typeof fetch }, (snapshot) => states.push(snapshot.state), 1);
    stream.start();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(250);
    await Promise.resolve();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(states.at(-1)).toBe("unavailable");
    stream.stop();
    vi.useRealTimers();
  });

  it("stops immediately on an auth failure", async () => {
    const states: string[] = [];
    const stream = new DeploymentStreamController({ deploymentId: "dep-1", apiBaseUrl: "https://api.example.test", fetchImpl: vi.fn(async () => new Response(null, { status: 401 })) as unknown as typeof fetch }, (snapshot) => states.push(snapshot.state));
    stream.start();
    await vi.waitFor(() => expect(states.at(-1)).toBe("unauthorized"));
    stream.stop();
  });

  it("drops unredacted frames instead of rendering raw log data", async () => {
    const snapshots: unknown[] = [];
    const unsafe = frame(3, "secret=raw").replace("\"redactionApplied\":true", "\"redactionApplied\":false");
    const stream = new DeploymentStreamController({ deploymentId: "dep-1", apiBaseUrl: "https://api.example.test", fetchImpl: vi.fn(async () => new Response(unsafe, { status: 200 })) as unknown as typeof fetch }, (snapshot) => snapshots.push(snapshot), 0);
    stream.start();
    await vi.waitFor(() => expect(snapshots.at(-1)).toMatchObject({ state: "unavailable", events: [] }));
  });
});

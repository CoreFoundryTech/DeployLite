import { describe, expect, it, vi } from "vitest";
import { MockHeartbeatClient, assertNoHostMutationPath, createSafeCommandEnvelope } from "./index.js";

describe("mock agent boundary", () => {
  it("creates safe command envelopes with no Docker, shell, or host mutation flags", () => {
    const envelope = createSafeCommandEnvelope("agent_mock_1", "heartbeat", new Date("2026-01-01T00:00:00.000Z"));

    expect(envelope.safety).toEqual({
      mockOnly: true,
      dockerSocketAccess: false,
      hostShellExecution: false,
      mutatesHost: false
    });
    expect(assertNoHostMutationPath(envelope)).toBe(true);
  });

  it("sends heartbeat contracts through an injected transport only", async () => {
    const transport = { sendHeartbeat: vi.fn().mockResolvedValue({ accepted: true, requestId: "api_req_1" }) };
    const client = new MockHeartbeatClient({
      agentId: "agent_mock_1",
      transport,
      now: () => new Date("2026-01-01T00:00:00.000Z")
    });

    const result = await client.sendHeartbeat();

    expect(result.accepted).toBe(true);
    expect(transport.sendHeartbeat).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "agent_mock_1",
        observedAt: "2026-01-01T00:00:00.000Z",
        resourceSnapshot: expect.objectContaining({ cpuLoad: 0.24 })
      })
    );
  });
});

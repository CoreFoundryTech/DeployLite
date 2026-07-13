import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DeploymentCommand } from "@deploylite/contracts";
import type { CommandBusClient } from "./executor/index.js";
import { CorruptTerminalOutboxError, DurableTerminalCommandBus, FileTerminalOutbox, InMemoryTerminalOutbox } from "./terminal-outbox.js";
import { AuthoritativeTerminalConflictError } from "./worker.js";

const agentId = "11111111-1111-4111-8111-111111111111";
const commandId = "22222222-2222-4222-8222-222222222222";
const base: DeploymentCommand = {
  id: commandId, deploymentId: "33333333-3333-4333-8333-333333333333", agentId, kind: "start", state: "claimed", payload: {}, requestedBy: null,
  requestId: "44444444-4444-4444-8444-444444444444", correlationId: "55555555-5555-4555-8555-555555555555",
  issuedAt: "2026-01-01T00:00:00.000Z", claimedAt: "2026-01-01T00:00:01.000Z", leaseExpiresAt: "2026-01-01T00:00:31.000Z", completedAt: null, failureReason: null
};
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function transport(overrides: Partial<CommandBusClient> = {}): CommandBusClient {
  return {
    claim: vi.fn(async () => base),
    reserveExecution: vi.fn(async () => ({ ...base, state: "executing" as const })),
    renewLease: vi.fn(async () => base),
    complete: vi.fn(async () => ({ ...base, state: "completed" as const, leaseExpiresAt: null, completedAt: "2026-01-01T00:00:02.000Z" })),
    fail: vi.fn(async () => ({ ...base, state: "failed" as const, leaseExpiresAt: null, completedAt: "2026-01-01T00:00:02.000Z", failureReason: "safe" })),
    ...overrides
  };
}

describe("DurableTerminalCommandBus", () => {
  it("retains a completed transition after a lost ACK and clears it after restart replay", async () => {
    const outbox = new InMemoryTerminalOutbox();
    let applied = false;
    const firstTransport = transport({ complete: vi.fn(async () => { applied = true; throw new Error("ACK lost"); }) });
    const first = new DurableTerminalCommandBus(agentId, firstTransport, outbox);
    await expect(first.complete(commandId, { raw: "must-not-persist" })).rejects.toThrow("ACK lost");
    expect(applied).toBe(true);
    expect(await outbox.load()).toEqual([expect.objectContaining({ commandId, action: "complete" })]);
    expect(JSON.stringify(await outbox.load())).not.toContain("must-not-persist");

    await expect(first.fail(commandId, "must not replace completion")).rejects.toThrow("Conflicting terminal acknowledgement intent");
    expect(firstTransport.fail).not.toHaveBeenCalled();
    expect(await outbox.load()).toEqual([expect.objectContaining({ commandId, action: "complete" })]);

    const restartedTransport = transport();
    const restarted = new DurableTerminalCommandBus(agentId, restartedTransport, outbox);
    await expect(restarted.replayPending()).resolves.toBe(true);
    expect(restartedTransport.complete).toHaveBeenCalledWith(commandId);
    expect(await outbox.load()).toEqual([]);
  });

  it("retries failed acknowledgements with only a generic redacted reason", async () => {
    const outbox = new InMemoryTerminalOutbox();
    const bus = new DurableTerminalCommandBus(agentId, transport({ fail: vi.fn(async () => { throw new Error("ACK lost"); }) }), outbox);
    await expect(bus.fail(commandId, "TOKEN=extremely-secret-value")).rejects.toThrow("ACK lost");
    const persisted = JSON.stringify(await outbox.load());
    expect(persisted).not.toContain("extremely-secret-value");
    expect(persisted).not.toContain("TOKEN");
    await expect(new DurableTerminalCommandBus(agentId, transport(), outbox).replayPending()).resolves.toBe(true);
    expect(await outbox.load()).toEqual([]);
  });

  it("records and drains a completion intent after an assignment-scoped authoritative failure", async () => {
    const outbox = new InMemoryTerminalOutbox([{ version: 1, commandId, agentId, action: "complete", createdAt: "2026-01-01T00:00:02.000Z" }]);
    const reconciled = { ...base, state: "failed" as const, leaseExpiresAt: null, completedAt: "2026-01-01T00:00:32.000Z", failureReason: "Agent command lease expired; execution was not retried." };
    const recordConflict = vi.fn();
    const bus = new DurableTerminalCommandBus(agentId, transport({ complete: vi.fn(async () => { throw new AuthoritativeTerminalConflictError(reconciled, "completed"); }) }), outbox, undefined, recordConflict);
    await expect(bus.replayPending()).resolves.toBe(true);
    expect(recordConflict).toHaveBeenCalledWith(expect.objectContaining({ commandId, agentId, attemptedState: "completed", authoritativeState: "failed" }));
    expect(await outbox.load()).toEqual([]);
  });

  it("drains a stale failure intent after an authoritative lease conflict without starving later work", async () => {
    const outbox = new InMemoryTerminalOutbox([{ version: 1, commandId, agentId, action: "fail", reason: "safe", createdAt: "2026-01-01T00:00:32.000Z" }]);
    const expired = { ...base, state: "failed" as const, leaseExpiresAt: null, completedAt: "2026-01-01T00:00:32.000Z", failureReason: "Agent command lease expired; failure was rejected." };
    const recordConflict = vi.fn();
    const bus = new DurableTerminalCommandBus(agentId, transport({ fail: vi.fn(async () => { throw new AuthoritativeTerminalConflictError(expired, "failed", true); }) }), outbox, undefined, recordConflict);
    await expect(bus.replayPending()).resolves.toBe(true);
    expect(recordConflict).toHaveBeenCalledWith(expect.objectContaining({ attemptedState: "failed", authoritativeState: "failed" }));
    expect(await outbox.load()).toEqual([]);
  });

  it.each(["complete", "fail"] as const)("drains only a late %s intent after authoritative cancellation", async (action) => {
    const otherCommandId = "66666666-6666-4666-8666-666666666666";
    const outbox = new InMemoryTerminalOutbox([
      { version: 1, commandId, agentId, action, ...(action === "fail" ? { reason: "safe" } : {}), createdAt: "2026-01-01T00:00:02.000Z" },
      { version: 1, commandId: otherCommandId, agentId, action: "complete", createdAt: "2026-01-01T00:00:03.000Z" }
    ]);
    const cancelled = { ...base, state: "cancelled" as const, leaseExpiresAt: null, completedAt: "2026-01-01T00:00:02.000Z" };
    const recordConflict = vi.fn();
    const complete = vi.fn(async (id: string) => {
      if (id === commandId) throw new AuthoritativeTerminalConflictError(cancelled, "completed");
      throw new Error("unrelated ACK remains unavailable");
    });
    const fail = vi.fn(async (id: string) => {
      if (id === commandId) throw new AuthoritativeTerminalConflictError(cancelled, "failed");
      throw new Error("unexpected fail");
    });
    const bus = new DurableTerminalCommandBus(agentId, transport({ complete, fail }), outbox, undefined, recordConflict);

    await expect(bus.replayPending()).resolves.toBe(false);

    expect(recordConflict).toHaveBeenCalledWith(expect.objectContaining({ commandId, agentId, attemptedState: action === "complete" ? "completed" : "failed", authoritativeState: "cancelled" }));
    expect(await outbox.load()).toEqual([expect.objectContaining({ commandId: otherCommandId, action: "complete" })]);
  });

  it("rejects a cancelled conflict with a mismatched assignment and preserves the intent", async () => {
    const outbox = new InMemoryTerminalOutbox([{ version: 1, commandId, agentId, action: "complete", createdAt: "2026-01-01T00:00:02.000Z" }]);
    const foreign = { ...base, agentId: "foreign-agent", state: "cancelled" as const, leaseExpiresAt: null, completedAt: "2026-01-01T00:00:02.000Z" };
    const bus = new DurableTerminalCommandBus(agentId, transport({ complete: vi.fn(async () => { throw new AuthoritativeTerminalConflictError(foreign, "completed"); }) }), outbox);

    await expect(bus.replayPending()).resolves.toBe(false);
    expect(await outbox.load()).toEqual([expect.objectContaining({ commandId, agentId, action: "complete" })]);
  });

  it("keeps the monotonic completion intent unless the conflict proves command and assignment identity", async () => {
    const outbox = new InMemoryTerminalOutbox([{ version: 1, commandId, agentId, action: "complete", createdAt: "2026-01-01T00:00:02.000Z" }]);
    const foreign = { ...base, id: "foreign-command", state: "failed" as const, leaseExpiresAt: null, completedAt: "2026-01-01T00:00:32.000Z", failureReason: "expired" };
    const bus = new DurableTerminalCommandBus(agentId, transport({ complete: vi.fn(async () => { throw new AuthoritativeTerminalConflictError(foreign, "completed"); }) }), outbox);
    await expect(bus.replayPending()).resolves.toBe(false);
    expect(await outbox.load()).toEqual([expect.objectContaining({ commandId, action: "complete" })]);
  });
});

describe("FileTerminalOutbox", () => {
  it("writes atomically with mode 0600 and reloads records", async () => {
    const directory = await mkdtemp(join(tmpdir(), "deploylite-outbox-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "state", "terminal.json");
    const outbox = new FileTerminalOutbox(path);
    await outbox.put({ version: 1, commandId, agentId, action: "complete", createdAt: "2026-01-01T00:00:00.000Z" });
    await expect(outbox.put({ version: 1, commandId, agentId, action: "fail", reason: "safe", createdAt: "2026-01-01T00:00:01.000Z" })).rejects.toThrow("Conflicting terminal acknowledgement intent");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await new FileTerminalOutbox(path).load()).toEqual([expect.objectContaining({ commandId, action: "complete" })]);
    expect((await readFile(path, "utf8"))).not.toContain("token");
  });

  it("quarantines corrupt state and fails closed", async () => {
    const directory = await mkdtemp(join(tmpdir(), "deploylite-outbox-corrupt-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "terminal.json");
    await writeFile(path, "{not-json", { mode: 0o644 });
    await chmod(path, 0o644);
    await expect(new FileTerminalOutbox(path).load()).rejects.toBeInstanceOf(CorruptTerminalOutboxError);
  });

  it("replays after restart, drains only the proven conflict, and processes unrelated records", async () => {
    const directory = await mkdtemp(join(tmpdir(), "deploylite-outbox-restart-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "terminal.json");
    const first = new FileTerminalOutbox(path);
    const otherCommandId = "66666666-6666-4666-8666-666666666666";
    await first.put({ version: 1, commandId, agentId, action: "complete", createdAt: "2026-01-01T00:00:00.000Z" });
    await first.put({ version: 1, commandId: otherCommandId, agentId, action: "complete", createdAt: "2026-01-01T00:00:01.000Z" });
    const reconciled = { ...base, state: "cancelled" as const, leaseExpiresAt: null, completedAt: "2026-01-01T00:00:32.000Z" };
    const complete = vi.fn(async (id: string) => {
      if (id === commandId) throw new AuthoritativeTerminalConflictError(reconciled, "completed");
      return { ...base, id, state: "completed" as const, leaseExpiresAt: null, completedAt: "2026-01-01T00:00:02.000Z" };
    });

    const restarted = new DurableTerminalCommandBus(agentId, transport({ complete }), new FileTerminalOutbox(path));
    await expect(restarted.replayPending()).resolves.toBe(true);
    expect(complete).toHaveBeenCalledTimes(2);
    expect(await new FileTerminalOutbox(path).load()).toEqual([]);
  });
});

import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DeploymentCommand } from "@deploylite/contracts";
import type { CommandBusClient } from "./executor/index.js";
import { CorruptTerminalOutboxError, DurableTerminalCommandBus, FileTerminalOutbox, InMemoryTerminalOutbox } from "./terminal-outbox.js";

const agentId = "11111111-1111-4111-8111-111111111111";
const commandId = "22222222-2222-4222-8222-222222222222";
const base: DeploymentCommand = {
  id: commandId, deploymentId: "33333333-3333-4333-8333-333333333333", agentId, kind: "start", state: "claimed", payload: {}, requestedBy: null,
  requestId: "44444444-4444-4444-8444-444444444444", correlationId: "55555555-5555-4555-8555-555555555555",
  issuedAt: "2026-01-01T00:00:00.000Z", claimedAt: "2026-01-01T00:00:01.000Z", completedAt: null, failureReason: null
};
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function transport(overrides: Partial<CommandBusClient> = {}): CommandBusClient {
  return {
    claim: vi.fn(async () => base),
    complete: vi.fn(async () => ({ ...base, state: "completed" as const, completedAt: "2026-01-01T00:00:02.000Z" })),
    fail: vi.fn(async () => ({ ...base, state: "failed" as const, completedAt: "2026-01-01T00:00:02.000Z", failureReason: "safe" })),
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
});

describe("FileTerminalOutbox", () => {
  it("writes atomically with mode 0600 and reloads records", async () => {
    const directory = await mkdtemp(join(tmpdir(), "deploylite-outbox-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "state", "terminal.json");
    const outbox = new FileTerminalOutbox(path);
    await outbox.put({ version: 1, commandId, agentId, action: "complete", createdAt: "2026-01-01T00:00:00.000Z" });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await new FileTerminalOutbox(path).load()).toHaveLength(1);
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
});

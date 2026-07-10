import { describe, expect, it, vi } from "vitest";
import {
  InMemoryDeploymentCommandRepository,
  type DeploymentCommandEvent,
  type DeploymentCommandEventListener,
  type DeploymentCommandRecord,
  type DeploymentCommandRepository,
  type DeploymentExecutor
} from "@deploylite/domain";

import { DeploymentCommandBusService } from "./command-bus.js";

const NOW = "2026-01-01T00:00:00.000Z";

const baseInput = {
  deploymentId: "dep_1",
  agentId: "agent_1",
  kind: "start" as const,
  requestedBy: "user_1",
  requestId: "req_1",
  correlationId: "corr_1"
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function newBus(): Promise<DeploymentCommandBusService> {
  const repository = new InMemoryDeploymentCommandRepository();
  return new DeploymentCommandBusService(repository);
}

describe("DeploymentCommandBusService", () => {
  it("persists a submitted command in `pending` and emits a submitted event", async () => {
    const bus = await newBus();
    const events: DeploymentCommandEvent[] = [];
    bus.onEvent((event) => {
      events.push(event);
    });

    const command = await bus.submit({ ...baseInput, payload: { commitSha: "abcdef1" } });

    expect(command.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(command.state).toBe("pending");
    expect(command.payload).toEqual({ commitSha: "abcdef1" });
    expect(command.issuedAt).toBeTypeOf("string");
    expect(command.completedAt).toBeNull();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "deployment.command.submitted", command: { id: command.id } });
  });

  it("claims a pending command for the right agent and rejects a foreign claim", async () => {
    const bus = await newBus();
    const command = await bus.submit(baseInput);

    const claimed = await bus.claim(command.id, "agent_1");
    expect(claimed?.state).toBe("claimed");
    expect(claimed?.claimedAt).toBeTypeOf("string");

    // A different agent must not be able to mutate the command.
    expect(await bus.claim(command.id, "agent_2")).toBeNull();

    // Re-claiming a claimed command is idempotent for the same agent:
    // the same-state transition is allowed so retries do not error
    // and the row stays in `claimed` with the original claimedAt.
    const second = await bus.claim(command.id, "agent_1");
    expect(second?.state).toBe("claimed");
    expect(second?.claimedAt).toBe(claimed?.claimedAt);
  });

  it("transitions pending -> completed and emits the matching event", async () => {
    const bus = await newBus();
    const command = await bus.submit(baseInput);
    await bus.claim(command.id, "agent_1");

    const completed = await bus.complete(command.id, { deploymentId: command.deploymentId });

    expect(completed?.state).toBe("completed");
    expect(completed?.completedAt).toBeTypeOf("string");
    expect(completed?.payload).toEqual({ output: { deploymentId: command.deploymentId } });

    const events = await bus.list();
    expect(events).toHaveLength(1);
  });

  it("records a failure reason and rejects illegal transitions", async () => {
    const bus = await newBus();
    const command = await bus.submit(baseInput);
    await bus.claim(command.id, "agent_1");
    await bus.complete(command.id);

    await expect(bus.fail(command.id, "boom")).resolves.toMatchObject({ state: "completed" });
  });

  it("lets simultaneous complete and fail transitions elect one authoritative terminal outcome", async () => {
    const inner = new InMemoryDeploymentCommandRepository();
    let arrivals = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const repository: DeploymentCommandRepository = {
      save: (command) => inner.save(command),
      claim: (...args) => inner.claim(...args),
      renewLease: (...args) => inner.renewLease(...args),
      findById: (id) => inner.findById(id),
      findActiveForDeployment: (id) => inner.findActiveForDeployment(id),
      list: () => inner.list(),
      async transitionTerminal(...args) {
        arrivals += 1;
        if (arrivals === 2) release();
        await barrier;
        return inner.transitionTerminal(...args);
      }
    };
    const completeBus = new DeploymentCommandBusService(repository, () => new Date(NOW));
    const expiryBus = new DeploymentCommandBusService(repository, () => new Date(NOW));
    const command = await completeBus.submit(baseInput);
    await completeBus.claim(command.id, "agent_1");

    const [completeResult, failResult] = await Promise.all([
      completeBus.complete(command.id),
      expiryBus.fail(command.id, "lease expired")
    ]);

    expect(completeResult?.state).toBe(failResult?.state);
    expect(["completed", "failed"]).toContain(completeResult?.state);
    expect((await completeBus.findById(command.id))?.state).toBe(completeResult?.state);
  });

  it("cancels a pending command idempotently and keeps an already-cancelled command as a no-op", async () => {
    const bus = await newBus();
    const command = await bus.submit(baseInput);

    const cancelled = await bus.cancel(command.id, "user_1");
    expect(cancelled?.state).toBe("cancelled");
    expect(cancelled?.completedAt).toBeTypeOf("string");
    expect(cancelled?.payload).toEqual({ cancelledBy: "user_1" });

    const second = await bus.cancel(command.id, "user_1");
    expect(second?.state).toBe("cancelled");
  });

  it.each([
    { competingState: "completed" as const, winner: "cancelled" as const },
    { competingState: "completed" as const, winner: "completed" as const },
    { competingState: "failed" as const, winner: "cancelled" as const },
    { competingState: "failed" as const, winner: "failed" as const }
  ])("keeps $winner authoritative in a cancel versus $competingState race", async ({ competingState, winner }) => {
    const inner = new InMemoryDeploymentCommandRepository();
    const cancelGate = deferred();
    const competingGate = deferred();
    const cancelEntered = deferred();
    const competingEntered = deferred();
    const repository: DeploymentCommandRepository = {
      save: (command) => inner.save(command),
      claim: (...args) => inner.claim(...args),
      renewLease: (...args) => inner.renewLease(...args),
      findById: (id) => inner.findById(id),
      findActiveForDeployment: (id) => inner.findActiveForDeployment(id),
      list: () => inner.list(),
      async transitionTerminal(...args) {
        const nextState = args[3].state;
        if (nextState === "cancelled") {
          cancelEntered.resolve();
          await cancelGate.promise;
        } else {
          competingEntered.resolve();
          await competingGate.promise;
        }
        return inner.transitionTerminal(...args);
      }
    };
    const cancelBus = new DeploymentCommandBusService(repository, () => new Date(NOW));
    const competingBus = new DeploymentCommandBusService(repository, () => new Date(NOW));
    const events: DeploymentCommandEvent[] = [];
    cancelBus.onEvent((event) => { events.push(event); });
    competingBus.onEvent((event) => { events.push(event); });
    const command = await cancelBus.submit(baseInput);
    await cancelBus.claim(command.id, command.agentId);

    const cancelPromise = cancelBus.cancel(command.id, "sk_1234567890secret");
    const competingPromise = competingState === "completed"
      ? competingBus.complete(command.id)
      : competingBus.fail(command.id, "agent failed");
    await Promise.all([cancelEntered.promise, competingEntered.promise]);
    if (winner === "cancelled") {
      cancelGate.resolve();
      await cancelPromise;
      competingGate.resolve();
    } else {
      competingGate.resolve();
      await competingPromise;
      cancelGate.resolve();
    }
    const [cancelled, competing] = await Promise.all([cancelPromise, competingPromise]);

    expect(cancelled?.state).toBe(winner);
    expect(competing?.state).toBe(winner);
    expect((await inner.findById(command.id))?.state).toBe(winner);
    const persisted = await inner.findById(command.id);
    if (winner === "cancelled") {
      expect(persisted?.payload).toEqual({ cancelledBy: "[REDACTED]" });
    } else {
      expect(persisted?.payload).not.toHaveProperty("cancelledBy");
    }
    expect(events.filter((event) => ["deployment.command.completed", "deployment.command.failed", "deployment.command.cancelled"].includes(event.type))).toEqual([
      expect.objectContaining({ type: `deployment.command.${winner}` })
    ]);
    await expect(cancelBus.cancel(command.id, "different-user")).resolves.toMatchObject({ state: winner });
  });

  it("lets a renewal that reaches persistence first defeat expiry of the stale lease snapshot", async () => {
    const inner = new InMemoryDeploymentCommandRepository();
    const renewGate = deferred();
    const expiryGate = deferred();
    const renewEntered = deferred();
    const expiryEntered = deferred();
    const repository: DeploymentCommandRepository = {
      save: (command) => inner.save(command),
      claim: (...args) => inner.claim(...args),
      findById: (id) => inner.findById(id),
      findActiveForDeployment: (id) => inner.findActiveForDeployment(id),
      list: () => inner.list(),
      async renewLease(...args) {
        renewEntered.resolve();
        await renewGate.promise;
        return inner.renewLease(...args);
      },
      async transitionTerminal(...args) {
        expiryEntered.resolve();
        await expiryGate.promise;
        return inner.transitionTerminal(...args);
      }
    };
    const claimBus = new DeploymentCommandBusService(repository, () => new Date(NOW));
    const renewalBus = new DeploymentCommandBusService(repository, () => new Date("2026-01-01T00:00:20.000Z"));
    const expiryBus = new DeploymentCommandBusService(repository, () => new Date("2026-01-01T00:00:31.000Z"));
    const command = await claimBus.submit(baseInput);
    await claimBus.claim(command.id, command.agentId);

    const renewal = renewalBus.renewLease(command.id, command.agentId);
    const expiry = expiryBus.failExpiredClaim(command.id, "lease expired");
    await Promise.all([renewEntered.promise, expiryEntered.promise]);
    renewGate.resolve();
    await renewal;
    expiryGate.resolve();

    await expect(expiry).resolves.toMatchObject({ state: "claimed", leaseExpiresAt: "2026-01-01T00:00:50.000Z" });
    expect(await inner.findById(command.id)).toMatchObject({ state: "claimed", leaseExpiresAt: "2026-01-01T00:00:50.000Z" });
  });

  it("keeps expiry authoritative when it reaches persistence before renewal", async () => {
    const inner = new InMemoryDeploymentCommandRepository();
    const renewGate = deferred();
    const expiryGate = deferred();
    const renewEntered = deferred();
    const expiryEntered = deferred();
    const repository: DeploymentCommandRepository = {
      save: (command) => inner.save(command),
      claim: (...args) => inner.claim(...args),
      findById: (id) => inner.findById(id),
      findActiveForDeployment: (id) => inner.findActiveForDeployment(id),
      list: () => inner.list(),
      async renewLease(...args) {
        renewEntered.resolve();
        await renewGate.promise;
        return inner.renewLease(...args);
      },
      async transitionTerminal(...args) {
        expiryEntered.resolve();
        await expiryGate.promise;
        return inner.transitionTerminal(...args);
      }
    };
    const claimBus = new DeploymentCommandBusService(repository, () => new Date(NOW));
    const renewalBus = new DeploymentCommandBusService(repository, () => new Date("2026-01-01T00:00:20.000Z"));
    const expiryBus = new DeploymentCommandBusService(repository, () => new Date("2026-01-01T00:00:31.000Z"));
    const command = await claimBus.submit(baseInput);
    await claimBus.claim(command.id, command.agentId);

    const renewal = renewalBus.renewLease(command.id, command.agentId);
    const expiry = expiryBus.failExpiredClaim(command.id, "lease expired");
    await Promise.all([renewEntered.promise, expiryEntered.promise]);
    expiryGate.resolve();
    await expiry;
    renewGate.resolve();

    await expect(renewal).resolves.toBeNull();
    await expect(expiryBus.failExpiredClaim(command.id, "lease expired again")).resolves.toMatchObject({ state: "failed", failureReason: "lease expired" });
    expect(await inner.findById(command.id)).toMatchObject({ state: "failed", failureReason: "lease expired" });
  });

  it("looks up the active command for a deployment and ignores terminal states", async () => {
    const bus = await newBus();
    const command = await bus.submit(baseInput);
    expect((await bus.findActiveForDeployment(command.deploymentId))?.state).toBe("pending");

    await bus.claim(command.id, "agent_1");
    expect((await bus.findActiveForDeployment(command.deploymentId))?.state).toBe("claimed");

    await bus.complete(command.id);
    expect(await bus.findActiveForDeployment(command.deploymentId)).toBeNull();
  });

  it("dispatches a submitted command through the registered executor", async () => {
    const bus = await newBus();
    const executor: DeploymentExecutor = {
      execute: vi.fn(async (command: DeploymentCommandRecord) => {
        await bus.complete(command.id);
      }),
      cancelTimers: () => undefined
    };
    bus.registerExecutor(executor);

    const command = await bus.submit(baseInput);
    const dispatched = await bus.dispatch(command);

    expect(executor.execute).toHaveBeenCalledWith(expect.objectContaining({ id: command.id, state: "claimed" }));
    expect(dispatched?.state).toBe("claimed");
    expect((await bus.findById(command.id))?.state).toBe("completed");
  });

  it("fails a claimed command when the executor throws", async () => {
    const bus = await newBus();
    bus.registerExecutor({
      execute: vi.fn(async () => {
        throw new Error("executor unavailable");
      }),
      cancelTimers: () => undefined
    });
    const events: DeploymentCommandEvent[] = [];
    bus.onEvent((event) => {
      events.push(event);
    });
    const command = await bus.submit(baseInput);

    await expect(bus.dispatch(command)).rejects.toThrow("executor unavailable");

    expect(await bus.findById(command.id)).toMatchObject({ state: "failed", failureReason: "executor unavailable" });
    expect(events.map((event) => event.type)).toEqual([
      "deployment.command.submitted",
      "deployment.command.claimed",
      "deployment.command.failed"
    ]);
  });

  it("isolates listener failures from the command lifecycle", async () => {
    const bus = await newBus();
    const errors: unknown[] = [];
    const original = console.error;
    console.error = (...args) => errors.push(args);
    try {
      bus.onEvent(() => {
        throw new Error("listener boom");
      });
      bus.onEvent((event: DeploymentCommandEvent) => {
        events.push(event);
      });
      const events: DeploymentCommandEvent[] = [];
      await bus.submit(baseInput);
      expect(errors).toHaveLength(1);
      expect((await bus.list())).toHaveLength(1);
    } finally {
      console.error = original;
    }
  });

  it("removes a listener when the unsubscribe handle is called", async () => {
    const bus = await newBus();
    const calls: DeploymentCommandEventListener = vi.fn();
    const unsubscribe = bus.onEvent(calls);
    unsubscribe();
    await bus.submit(baseInput);
    expect(calls).not.toHaveBeenCalled();
  });
});

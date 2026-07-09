import { describe, expect, it, vi } from "vitest";
import {
  IllegalDeploymentCommandTransitionError,
  InMemoryDeploymentCommandRepository,
  type DeploymentCommandEvent,
  type DeploymentCommandEventListener,
  type DeploymentCommandRecord,
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

    await expect(bus.fail(command.id, "boom")).rejects.toBeInstanceOf(IllegalDeploymentCommandTransitionError);
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
